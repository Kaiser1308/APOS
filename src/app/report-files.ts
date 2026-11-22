import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Glob with `*`, `?` and `**`, forward slashes only; enough for report locations. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}

function walk(root: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') walk(root, rel, out);
    } else out.push(rel);
  }
}

/** Files under `root` matching a relative path or glob, sorted. A plain path matches only that file. */
export function findReportFiles(root: string, pattern: string): string[] {
  const normal = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  if (/^\/|^[A-Za-z]:|(^|\/)\.\.(\/|$)/.test(normal)) return [];
  const wildcard = /[*?]/.test(normal);
  const start = wildcard
    ? normal
        .slice(0, Math.max(0, normal.search(/[*?]/)))
        .replace(/[^/]*$/, '')
        .replace(/\/$/, '')
    : '';
  const files: string[] = [];
  if (wildcard) walk(root, start, files);
  else files.push(normal);
  const matcher = globToRegExp(normal);
  return files.filter(file => matcher.test(file)).sort();
}

/** The contents of every file the pattern matches that can be read; unreadable ones are skipped. */
export function readReportFiles(root: string, pattern: string): string[] {
  const contents: string[] = [];
  for (const file of findReportFiles(root, pattern)) {
    try {
      contents.push(readFileSync(join(root, file), 'utf8'));
    } catch {
      /* a missing plain path is reported as "no report file" by the caller */
    }
  }
  return contents;
}
