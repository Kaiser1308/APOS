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
