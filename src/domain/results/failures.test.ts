import { expect, it } from 'vitest';
import { reportFailures } from './failures.js';

it('lists failed and errored tests, sorted, and ignores skips', () => {
  const tests = [
    { id: 'b', status: 'fail' as const },
    { id: 'a', status: 'error' as const },
    { id: 'c', status: 'skip' as const },
    { id: 'd', status: 'pass' as const },
  ];
  expect(reportFailures({ kind: 'tests', tests })).toEqual({ failures: ['a', 'b'] });
});
it('treats an empty or unreadable report as a problem, not as "nothing failed"', () => {
  expect(reportFailures({ kind: 'tests', tests: [] })).toEqual({ problem: 'the report lists no tests' });
  expect(reportFailures({ kind: 'unreadable', reason: 'bad' })).toEqual({ problem: 'bad' });
  expect(reportFailures({ kind: 'metric', name: 'm', value: 1 })).toHaveProperty('problem');
});
it('takes error-level findings from an apos-json report', () => {
  expect(
    reportFailures({
      kind: 'findings',
      findings: [
        { ruleId: 'r', level: 'error', file: 'f', line: 2 },
        { ruleId: 'w', level: 'warning' },
      ],
    }),
  ).toEqual({ failures: ['r@f:2'] });
});
