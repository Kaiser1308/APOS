// Helpers shared by the transcript readers (activity.ts, activity-antigravity.ts).
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What an agent did, read from its own transcript (Codex rollout or Claude Code session). The agents' reasoning is
 * encrypted or empty in both formats, so only what they wrote, ran and got back is shown, never inferred thoughts.
 */
export type ActivityKind = 'say' | 'plan' | 'command' | 'file-change' | 'result' | 'error';
export type Activity = { at: string; kind: ActivityKind; text: string; truncated: boolean };
export type Agent = 'codex' | 'claude' | 'antigravity';

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
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)\s*[=:]\s*["']?[^\s"']{4,}/gi, '$1=[redacted]'],
];
/** Pattern-based: it hides common shapes of secrets and does not promise to hide every one. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, to]) => out.replace(pattern, to), text);
}

function clip(text: string): { text: string; truncated: boolean } {
  const safe = redact(text);
  return safe.length > MAX_ITEM_CHARS
    ? { text: `${safe.slice(0, MAX_ITEM_CHARS)}…`, truncated: true }
    : { text: safe, truncated: false };
}
export const item = (at: string, kind: ActivityKind, raw: string): Activity => ({ at, kind, ...clip(raw) });
export const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
export const asText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map(part => (typeof part === 'string' ? part : asText(obj(part).text ?? obj(part).content)))
      .filter(Boolean)
      .join('\n');
  return value === undefined || value === null ? '' : JSON.stringify(value);
};
export const lines = (raw: string): unknown[] =>
  raw.split('\n').flatMap(line => {
    if (!line) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

export const norm = (path: string) => resolve(path).replace(/\\/g, '/').toLowerCase();

/** Reads a file for a scan: all of it, or only its last MAX_SCAN_BYTES (cut at a line start) when it is larger. */
export function readScan(file: string): { head: string; body: string } {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const headLen = Math.min(size, 65_536),
      head = Buffer.alloc(headLen);
    readSync(fd, head, 0, headLen, 0);
    if (size <= MAX_SCAN_BYTES) return { head: head.toString('utf8'), body: readFileSync(file, 'utf8') };
    const tail = Buffer.alloc(MAX_SCAN_BYTES);
    readSync(fd, tail, 0, MAX_SCAN_BYTES, size - MAX_SCAN_BYTES);
    const text = tail.toString('utf8');
    return { head: head.toString('utf8'), body: text.slice(text.indexOf('\n') + 1) };
  } finally {
    closeSync(fd);
  }
}
/** A line is complete only when it ends in a newline; the agent may still be writing the last one. */
export const completeOnly = (raw: string) => (raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1));
