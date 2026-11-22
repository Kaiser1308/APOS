import { readAposJson } from './apos-json.js';
import { readJunit } from './junit.js';
import { readMetric } from './metric.js';
import { readSarif } from './sarif.js';
import { unreadable, type ParsedReport, type ResultFormat } from './types.js';

export type { Finding, ParsedReport, ResultFormat, TestOutcome } from './types.js';

/** Pure reader for the four result formats. It never throws: a missing, empty or broken report is `unreadable`. */
export function readReport(format: ResultFormat, content: string, opts: { metric?: string } = {}): ParsedReport {
  if (!content.trim()) return unreadable(`${format} report is empty`);
  switch (format) {
    case 'junit':
      return readJunit(content);
    case 'sarif':
      return readSarif(content);
    case 'metric':
      return readMetric(content, opts.metric);
    case 'apos-json':
      return readAposJson(content);
  }
}

/**
 * Merges the reports of several files (a Gradle or Surefire directory) into one. No report at all, or any
 * unreadable one, makes the whole thing unreadable: a missing file must not look like fewer tests.
 */
export function mergeReports(reports: ParsedReport[]): ParsedReport {
  if (!reports.length) return unreadable('no report file was found');
  const bad = reports.find(report => report.kind === 'unreadable');
  if (bad) return bad;
  const [first] = reports;
  if (first?.kind === 'tests') {
    if (!reports.every(report => report.kind === 'tests')) return unreadable('report files mix formats');
    return { kind: 'tests', tests: reports.flatMap(report => (report.kind === 'tests' ? report.tests : [])) };
  }
  if (first?.kind === 'findings') {
    if (!reports.every(report => report.kind === 'findings')) return unreadable('report files mix formats');
    return {
      kind: 'findings',
      findings: reports.flatMap(report => (report.kind === 'findings' ? report.findings : [])),
    };
  }
  return reports.length === 1 && first ? first : unreadable('a metric report must be a single file');
}
