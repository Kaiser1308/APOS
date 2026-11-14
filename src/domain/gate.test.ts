import { describe, expect, it } from 'vitest';
import type { CommandCheck } from './contracts.js';
import {
  evaluateCommandCheck,
  extractFailures,
  gateShortfalls,
  sourceDigest,
  summarizeGate,
  type CheckRun,
} from './gate.js';
import { spec, gateReport, DELIVERY } from './fixtures.test-support.js';

const regression: CommandCheck = {
  id: 'CHK-R',
  kind: 'command',
  command: 'npm test',
  expect: 'no-new-failures',
  failurePattern: '^FAIL (\\S+)',
  runs: 1,
  timeoutMs: 1000,
  env: {},
};
const run = (exitCode: number | null, failures: string[] = [], timedOut = false): CheckRun => ({
  commit: 'x',
  exitCode,
  timedOut,
  logRef: 'log',
  logSha256: '0',
  failures,
});

describe('check evaluation', () => {
  it('passes a must-pass check only on exit 0 at delivery', () => {
    const check = { ...regression, expect: 'pass' as const };
    expect(evaluateCommandCheck(check, [], [run(0)]).status).toBe('pass');
    expect(evaluateCommandCheck(check, [], [run(1)]).status).toBe('fail');
  });
  it('fails on a failure that is new at delivery and names it', () => {
    const result = evaluateCommandCheck(regression, [run(1, ['old'])], [run(1, ['old', 'new'])]);
    expect(result).toMatchObject({ status: 'fail', newFailures: ['new'] });
  });
  it('passes when delivery only keeps failures already present on base', () => {
    expect(evaluateCommandCheck(regression, [run(1, ['old'])], [run(1, ['old'])]).status).toBe('pass');
  });
  it('is unverifiable, not green, when the baseline cannot run', () => {
    expect(evaluateCommandCheck(regression, [run(127)], [run(0)]).status).toBe('unverifiable');
    expect(evaluateCommandCheck(regression, [], [run(0)]).status).toBe('unverifiable');
  });
  it('fails a delivery that crashes without identifiable failures', () => {
    expect(evaluateCommandCheck(regression, [run(0)], [run(2)]).status).toBe('fail');
  });
  it('is unverifiable when repeated runs disagree or a run times out', () => {
    const twice = { ...regression, runs: 2 };
    expect(evaluateCommandCheck(twice, [run(0), run(0)], [run(0), run(1, ['t'])]).reason).toMatch(/flaky/);
    expect(evaluateCommandCheck(twice, [run(0), run(0)], [run(null, [], true)]).status).toBe('unverifiable');
  });
  it('extracts unique failure identities with the declared pattern', () => {
    expect(extractFailures('FAIL a\nok b\nFAIL c\nFAIL a\n', '^FAIL (\\S+)')).toEqual(['a', 'c']);
  });
  it('summarizes red over unverifiable over pending over green', () => {
    const r = (status: 'pass' | 'fail' | 'unverifiable' | 'manual-pending') => ({
      checkId: 'C',
      status,
      reason: '',
      base: [],
      delivery: [],
      newFailures: [],
    });
    expect(summarizeGate([r('pass'), r('unverifiable'), r('fail')])).toBe('red');
    expect(summarizeGate([r('pass'), r('manual-pending'), r('unverifiable')])).toBe('unverifiable');
    expect(summarizeGate([r('pass'), r('manual-pending')])).toBe('pending');
    expect(summarizeGate([r('pass')])).toBe('green');
  });
});

describe('gate shortfalls', () => {
  it('accepts a green gate on the reviewed commit', () => {
    expect(gateShortfalls(spec, gateReport(DELIVERY), DELIVERY)).toEqual([]);
  });
  it('rejects a gate from another Goal version or source snapshot', () => {
    expect(gateShortfalls({ ...spec, version: 2 }, gateReport(DELIVERY))[0]).toMatch(/Goal v1, current is v2/);
    expect(
      gateShortfalls({ ...spec, source: { ...spec.source, sha256: sourceDigest('other') } }, gateReport(DELIVERY)),
    ).toContain('gate ran against a different source snapshot');
  });
  it('rejects a green gate that skipped a check an acceptance criterion needs', () => {
    const gate = { ...gateReport(DELIVERY), checks: [] };
    expect(gateShortfalls(spec, gate)).toEqual(['AC-1 lacks passing check(s): CHK-1']);
  });
  it('hashes source text independent of line endings', () => {
    expect(sourceDigest('a\r\nb\r\n')).toBe(sourceDigest('a\nb\n'));
  });
});
