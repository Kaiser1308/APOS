import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { GoalEvent } from '../domain/transitions.js';
import { worktreePath } from '../runtime/orca.js';

/**
 * What an agent did, read from its own transcript (Codex rollout or Claude Code session). The agents' reasoning is
 * encrypted or empty in both formats, so only what they wrote, ran and got back is shown, never inferred thoughts.
 */
export type ActivityKind = 'say' | 'plan' | 'command' | 'file-change' | 'result' | 'error';
export type Activity = { at: string; kind: ActivityKind; text: string; truncated: boolean };
export type Agent = 'codex' | 'claude';

export const MAX_ITEM_CHARS = 4000;
export const MAX_SCAN_BYTES = 8_000_000;
export const MAX_ITEMS = 200;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)\s*[=:]\s*["']?[^\s"']{4,}/gi, '$1=[redacted]']
];
/** Pattern-based: it hides common shapes of secrets and does not promise to hide every one. */
export function redact(text: string): string { return SECRET_PATTERNS.reduce((out, [pattern, to]) => out.replace(pattern, to), text); }

function clip(text: string): { text: string; truncated: boolean } {
  const safe = redact(text);
  return safe.length > MAX_ITEM_CHARS ? { text: `${safe.slice(0, MAX_ITEM_CHARS)}…`, truncated: true } : { text: safe, truncated: false };
}
const item = (at: string, kind: ActivityKind, raw: string): Activity => ({ at, kind, ...clip(raw) });
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
const asText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => (typeof part === 'string' ? part : asText(obj(part).text ?? obj(part).content))).filter(Boolean).join('\n');
  return value === undefined || value === null ? '' : JSON.stringify(value);
};
const lines = (raw: string): unknown[] => raw.split('\n').flatMap(line => { if (!line) return []; try { return [JSON.parse(line)]; } catch { return []; } });

/** Codex rollout lines to activity. Developer and user turns and encrypted reasoning are skipped. */
export function parseCodex(raw: string): Activity[] {
  const out: Activity[] = [];
  for (const row of lines(raw)) {
    const r = obj(row), p = obj(r.payload), at = typeof r.timestamp === 'string' ? r.timestamp : '';
    // A turn that ended in an error (usage limit, unknown model) leaves only this row; without it the session looks as if it never ran.
    if (r.type === 'event_msg' && p.type === 'task_complete' && at && obj(p.error).message) { out.push(item(at, 'error', asText(obj(p.error).message))); continue; }
    if (r.type !== 'response_item' || !at) continue;
    if (p.type === 'message' && p.role === 'assistant') { const text = asText(p.content).trim(); if (text) out.push(item(at, 'say', text)); }
    else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const name = String(p.name ?? 'tool'), body = asText(p.input ?? p.arguments);
      out.push(item(at, /plan/i.test(name) ? 'plan' : /patch|edit|write/i.test(name) ? 'file-change' : 'command', `${name}: ${body}`));
    }
    else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const text = asText(p.output);
      out.push(item(at, /(?:exit code|Process exited with code)\s*[1-9]|error/i.test(text.slice(0, 400)) ? 'error' : 'result', text));
    }
  }
  return out;
}

/** Claude Code session lines to activity. `thinking` blocks are empty in practice and are skipped. */
export function parseClaude(raw: string): Activity[] {
  const out: Activity[] = [];
  for (const row of lines(raw)) {
    const r = obj(row), m = obj(r.message), at = typeof r.timestamp === 'string' ? r.timestamp : '';
    if (!at || !Array.isArray(m.content)) continue;
    for (const part of m.content as unknown[]) {
      const c = obj(part);
      if (r.type === 'assistant' && c.type === 'text') { const text = asText(c.text).trim(); if (text) out.push(item(at, 'say', text)); }
      else if (r.type === 'assistant' && c.type === 'tool_use') {
        const name = String(c.name ?? 'tool'), input = obj(c.input);
        if (name === 'TodoWrite') out.push(item(at, 'plan', Array.isArray(input.todos) ? (input.todos as unknown[]).map(todo => `[${String(obj(todo).status ?? '')}] ${String(obj(todo).content ?? '')}`).join('\n') : asText(input)));
        else if (name === 'Bash') out.push(item(at, 'command', String(input.command ?? asText(input))));
        else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) out.push(item(at, 'file-change', `${name} ${String(input.file_path ?? input.notebook_path ?? '')}`));
        else out.push(item(at, 'command', `${name}: ${asText(input)}`));
      }
      else if (r.type === 'user' && c.type === 'tool_result') out.push(item(at, c.is_error === true ? 'error' : 'result', asText(c.content)));
    }
  }
  return out;
}

export type Roots = { codex: string; claude: string };
export const defaultRoots = (): Roots => ({
  codex: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
  claude: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
});
const norm = (path: string) => resolve(path).replace(/\\/g, '/').toLowerCase();

/** Reads a file for a scan: all of it, or only its last MAX_SCAN_BYTES (cut at a line start) when it is larger. */
function readScan(file: string): { head: string; body: string } {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const headLen = Math.min(size, 65_536), head = Buffer.alloc(headLen);
    readSync(fd, head, 0, headLen, 0);
    if (size <= MAX_SCAN_BYTES) return { head: head.toString('utf8'), body: readFileSync(file, 'utf8') };
    const tail = Buffer.alloc(MAX_SCAN_BYTES);
    readSync(fd, tail, 0, MAX_SCAN_BYTES, size - MAX_SCAN_BYTES);
    const text = tail.toString('utf8');
    return { head: head.toString('utf8'), body: text.slice(text.indexOf('\n') + 1) };
  } finally { closeSync(fd); }
}
/** A line is complete only when it ends in a newline; the agent may still be writing the last one. */
const completeOnly = (raw: string) => (raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1));
const jsonls = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name)) : []);
function cwdOf(head: string, key: 'session_meta' | 'cwd'): string | undefined {
  for (const row of lines(completeOnly(head))) {
    const r = obj(row);
    if (key === 'session_meta' && r.type === 'session_meta' && typeof obj(r.payload).cwd === 'string') return obj(r.payload).cwd as string;
    if (key === 'cwd' && typeof r.cwd === 'string') return r.cwd;
  }
  return undefined;
}

export type Transcript = { agent: Agent; file: string; items: Activity[] };
/** Transcripts whose recorded cwd is the dispatch's worktree, cut to [since, until] (30 s of slack for clock drift). */
export function findTranscripts(worktree: string, since: string, until: string, roots: Roots): Transcript[] {
  const target = norm(worktree), from = Date.parse(since) - 30_000, to = Date.parse(until) + 30_000;
  const inWindow = (items: Activity[]) => items.filter(entry => { const t = Date.parse(entry.at); return t >= from && t <= to; });
  const found: Transcript[] = [];
  // Windows does not refresh mtime on a rollout Codex still holds open, so pick by day folder like the telemetry probe.
  const days = new Set<string>();
  for (let t = from - 86_400_000; t <= to + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    days.add(join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  for (const day of days) for (const file of jsonls(join(roots.codex, day))) {
    const scan = readScan(file);
    const cwd = cwdOf(scan.head, 'session_meta');
    if (!cwd || norm(cwd) !== target) continue;
    const items = inWindow(parseCodex(completeOnly(scan.body)));
    if (items.length) found.push({ agent: 'codex', file, items });
  }
  const dirName = resolve(worktree).replace(/[^A-Za-z0-9]/g, '-');
  for (const file of jsonls(join(roots.claude, dirName))) {
    const scan = readScan(file);
    const cwd = cwdOf(scan.head, 'cwd'); // the folder name is only a hint; the record says where the session really ran
    if (!cwd || norm(cwd) !== target) continue;
    const items = inWindow(parseClaude(completeOnly(scan.body)));
    if (items.length) found.push({ agent: 'claude', file, items });
  }
  return found;
}

export type Dispatch = { dispatchId: string; role: 'lead' | 'worker' | 'reviewer'; owner: string; at: string; worktree?: string };
/** Every dispatch the controller recorded for a Goal, with the worktree it ran in. The request names an id, never a path. */
export function dispatchesOf(events: GoalEvent[]): Dispatch[] {
  const out: Dispatch[] = [];
  for (const event of events) {
    const data = obj(event.data), ref = obj(data.ref);
    const add = (role: Dispatch['role'], owner: string, source: Record<string, unknown>) => {
      if (typeof source.dispatchId !== 'string') return;
      const id = typeof source.worktreeId === 'string' ? source.worktreeId : typeof source.worktree === 'string' ? source.worktree : undefined;
      out.push({ dispatchId: source.dispatchId, role, owner, at: event.at, worktree: id?.includes('::') ? worktreePath(id) : id && /[\\/]/.test(id) ? id : undefined });
    };
    // The Lead's own dispatch; when it then becomes the Solo owner, execution-started repeats its id and is not listed twice.
    if (event.type === 'lead-started') add('lead', 'goal', data);
    else if (event.type === 'execution-started' && out.some(entry => entry.dispatchId === data.dispatchId)) continue;
    else if (event.type === 'execution-started' || event.type === 'runtime-resumed') add('worker', 'goal', data);
    else if (event.type === 'package-started' || event.type === 'package-resumed') add('worker', String(data.packageId ?? 'goal'), ref);
    else if (event.type === 'review-dispatched') add('reviewer', typeof data.packageId === 'string' ? data.packageId : 'goal', data);
    else if (event.type === 'lead-woken') add('lead', 'goal', data);
  }
  return out;
}

export type ActivityReply = { found: boolean; reason?: string; matched: { agent: Agent; name: string }[]; total: number; offset: number; items: Activity[] };
/** One dispatch's activity. `after` is how many items the page already has; omitted means the latest MAX_ITEMS. */
export function readActivity(events: GoalEvent[], dispatchId: string, after: number | undefined, roots: Roots = defaultRoots(), now: Date = new Date()): ActivityReply | undefined {
  const all = dispatchesOf(events);
  const mine = all.find(entry => entry.dispatchId === dispatchId);
  if (!mine) return undefined;
  const none = (reason: string): ActivityReply => ({ found: false, reason, matched: [], total: 0, offset: 0, items: [] });
  if (!mine.worktree) return none('The controller did not record a worktree path for this dispatch.');
  // The window ends where the next dispatch in the same worktree begins, so a reused worktree does not mix sessions.
  const next = all.filter(entry => entry.worktree === mine.worktree && entry.at > mine.at && entry.dispatchId !== mine.dispatchId).map(entry => entry.at).sort()[0];
  const transcripts = findTranscripts(mine.worktree, mine.at, next ?? now.toISOString(), roots);
  if (!transcripts.length) return none('No Codex or Claude Code transcript was found for this worktree and time.');
  // A forked Codex session replays its parent's records with the same timestamps; show each record once.
  const seen = new Set<string>();
  const merged = transcripts.flatMap(t => t.items).filter(entry => { const key = `${entry.at}|${entry.kind}|${entry.text}`; return seen.has(key) ? false : (seen.add(key), true); }).sort((a, b) => a.at.localeCompare(b.at));
  const start = after === undefined ? Math.max(0, merged.length - MAX_ITEMS) : Math.min(Math.max(0, after), merged.length);
  return { found: true, matched: transcripts.map(t => ({ agent: t.agent, name: t.file.split(/[\\/]/).pop() ?? '' })), total: merged.length, offset: start, items: merged.slice(start, start + MAX_ITEMS) };
}
