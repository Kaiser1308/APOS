import type { ParsedReport } from './types.js';

/**
 * The identities of what failed in a report, for comparing base and delivery. A report that cannot be read,
 * or that lists no test at all, is a problem and never "nothing failed": an empty run proves nothing.
 */
export function reportFailures(report: ParsedReport): { failures: string[] } | { problem: string } {
  switch (report.kind) {
    case 'unreadable':
      return { problem: report.reason };
    case 'tests':
      return report.tests.length
        ? {
            failures: report.tests
              .filter(t => t.status === 'fail' || t.status === 'error')
              .map(t => t.id)
              .sort(),
          }
        : { problem: 'the report lists no tests' };
    case 'findings':
      return {
        failures: report.findings
          .filter(item => item.level === 'error')
          .map(item => `${item.ruleId}@${item.file ?? '?'}:${item.line ?? 0}`)
          .sort(),
      };
    case 'metric':
      return { problem: 'a metric report has no tests to compare' };
  }
}
