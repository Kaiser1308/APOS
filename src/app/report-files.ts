import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { globToRegExp } from '../domain/glob.js';
import { mergeReports, readReport, type ParsedReport, type ResultFormat } from '../domain/results/index.js';

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

/**
 * Reads the report a tool command left behind: the `{report}` file APOS provided when the command has the
 * placeholder, else every file the `report` path or glob matches under `cwd`. No file at all is unreadable.
 */
export function readToolReport(opts: {
  format: ResultFormat;
  command: string;
  report?: string;
  metric?: string;
  cwd: string;
  tempReport: string;
}): ParsedReport {
  let contents: string[];
  if (opts.command.includes('{report}')) {
    try {
      contents = [readFileSync(opts.tempReport, 'utf8')];
    } catch {
      contents = [];
    }
  } else contents = readReportFiles(opts.cwd, opts.report ?? '');
  return mergeReports(contents.map(content => readReport(opts.format, content, { metric: opts.metric })));
}
