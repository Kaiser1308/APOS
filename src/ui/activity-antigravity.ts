import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  completeOnly,
  item,
  lines,
  norm,
  obj,
  asText,
  readScan,
  type Activity,
  type Agent,
} from './activity-shared.js';

const unquote = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
};

/** Antigravity CLI transcript lines (`brain/<id>/.system_generated/logs/transcript.jsonl`) to activity. */
export function parseAntigravity(raw: string): Activity[] {
  const out: Activity[] = [];
  for (const row of lines(raw)) {
    const r = obj(row),
      at = typeof r.created_at === 'string' ? r.created_at : '';
    if (!at) continue;
    if (r.type === 'PLANNER_RESPONSE') {
      const text = typeof r.content === 'string' ? r.content.trim() : '';
      if (text) out.push(item(at, 'say', text));
      for (const part of Array.isArray(r.tool_calls) ? (r.tool_calls as unknown[]) : []) {
        const tc = obj(part),
          name = String(tc.name ?? 'tool'),
          args = obj(tc.args);
        if (name === 'run_command') out.push(item(at, 'command', unquote(args.CommandLine) || asText(args)));
        else if (/^(write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content)$/.test(name))
          out.push(item(at, 'file-change', `${name} ${unquote(args.Path ?? args.TargetFile)}`));
        else if (/plan|task/i.test(name)) out.push(item(at, 'plan', `${name}: ${asText(args)}`));
        else out.push(item(at, 'command', `${name}: ${asText(args)}`));
      }
    } else if (r.type === 'GENERIC') {
      const text = asText(r.content ?? r.error)
        .replace(/^(?:Created At: [^\r\n]+\r?\n|Completed At: [^\r\n]+\r?\n)+/g, '')
        .trim();
      if (!text) continue;
      const isErr =
        r.status === 'ERROR' ||
        Boolean(r.error) ||
        /(?:Command exited with code [1-9]|Encountered error)/i.test(text.slice(0, 400));
      out.push(item(at, isErr ? 'error' : 'result', text));
    }
  }
  return out;
}

/** Antigravity transcripts for a worktree: matched by history.jsonl workspace, the dispatch id in the head, or the path in the head. */
export function findAntigravity(
  root: string,
  target: string,
  dispatchId: string | undefined,
  inWindow: (items: Activity[]) => Activity[],
): { agent: Agent; file: string; items: Activity[] }[] {
  const found: { agent: Agent; file: string; items: Activity[] }[] = [];
  if (!existsSync(root)) return found;
  const convIds = new Set<string>();
  const historyFile = join(root, 'history.jsonl');
  if (existsSync(historyFile)) {
    const scan = readScan(historyFile);
    for (const row of lines(completeOnly(scan.body))) {
      const r = obj(row);
      if (typeof r.workspace === 'string' && norm(r.workspace) === target && typeof r.conversationId === 'string')
        convIds.add(r.conversationId);
    }
  }
  const brainDir = join(root, 'brain');
  if (existsSync(brainDir)) {
    for (const convId of readdirSync(brainDir)) {
      const file = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(file)) continue;
      const scan = readScan(file);
      const headNorm = scan.head.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
      if (!convIds.has(convId) && !(dispatchId && scan.head.includes(dispatchId)) && !headNorm.includes(target))
        continue;
      const items = inWindow(parseAntigravity(completeOnly(scan.body)));
      if (items.length) found.push({ agent: 'antigravity', file, items });
    }
  }
  return found;
}
