import { describe, expect, it } from 'vitest';
import { judgeFindings, judgeMetric, judgeTests } from './layer-verdict.js';
import type { Finding, TestOutcome } from './results/types.js';

const t = (id: string, status: TestOutcome['status'] = 'pass'): TestOutcome => ({ id, status });

describe('judgeTests', () => {
  const judge = (head: TestOutcome[][], base: TestOutcome[] | undefined, locked: string[] = []) =>
    judgeTests({ label: 'api.L2', head, base, locked });
  it('passes when nothing fails that did not already fail at the base', () => {
    expect(judge([[t('a'), t('b', 'fail')]], [t('a'), t('b', 'fail')])).toMatchObject({
      status: 'pass',
      newFailures: [],
      reason: expect.stringContaining('1 failing as at the base') as unknown,
    });
  });
  it('is red for a failure the base did not have, and for a failing test that is new', () => {
    expect(judge([[t('a', 'fail'), t('c', 'error')]], [t('a'), t('b')])).toMatchObject({
      status: 'fail',
      newFailures: ['a', 'c'],
    });
  });
  it('is unverifiable, naming the layer, when no test ran at all', () => {
    expect(judge([[]], [t('a')])).toMatchObject({
      status: 'unverifiable',
      reason: expect.stringContaining('api.L2: no test ran') as unknown,
    });
  });
  it('a locked test must pass even though it was red at the base', () => {
    const result = judge([[t('x', 'fail'), t('y')]], [t('x', 'fail'), t('y', 'fail')], ['x', 'y']);
    expect(result).toMatchObject({ status: 'fail', newFailures: [] });
    expect(result.reason).toContain('locked test x is fail');
    expect(judge([[t('y')]], [t('y', 'fail')], ['y']).status).toBe('pass');
  });
  it('a locked test that is not in the report is red, not skipped over', () => {
    expect(judge([[t('a')]], [t('a')], ['gone'])).toMatchObject({ status: 'fail' });
  });
  it('is unverifiable when repeated runs disagree, whatever the best run says', () => {
    const result = judge(
      [
        [t('a'), t('b')],
        [t('a', 'fail'), t('b')],
        [t('a'), t('b')],
      ],
      [t('a'), t('b')],
    );
    expect(result.status).toBe('unverifiable');
    expect(result.reason).toContain('runs disagree');
    expect(result.reason).toContain('a');
  });
  it('is unverifiable when a test is in one run and not in another', () => {
    expect(judge([[t('a')], [t('a'), t('b')]], [t('a')]).status).toBe('unverifiable');
  });
  it('treats a missing base as no failures there', () => {
    expect(judge([[t('a', 'fail')]], undefined)).toMatchObject({ status: 'fail', newFailures: ['a'] });
  });
  it('a failure at a locked layer is still checked against the base when the test is not locked', () => {
    expect(judge([[t('x'), t('z', 'fail')]], [t('x', 'fail'), t('z', 'fail')], ['x'])).toMatchObject({
      status: 'pass',
    });
  });
});

describe('judgeFindings', () => {
  const f = (level: Finding['level']): Finding => ({ ruleId: 'r', level });
  it('is red from the blocking level up, and says how many findings were lower', () => {
    expect(judgeFindings([f('error'), f('warning'), f('note')], 'error')).toMatchObject({
      status: 'fail',
      findings: { blocking: 1, lower: 2 },
    });
  });
  it('is not red for findings below the blocking level, but counts them', () => {
    const result = judgeFindings([f('warning'), f('note')], 'error');
    expect(result).toMatchObject({ status: 'pass', findings: { blocking: 0, lower: 2 } });
    expect(result.reason).toContain('2 finding(s) below error');
  });
  it('failOn warning blocks warnings and errors', () => {
    expect(judgeFindings([f('warning')], 'warning').status).toBe('fail');
    expect(judgeFindings([f('note')], 'warning').status).toBe('pass');
  });
  it('no findings is a pass', () => {
    expect(judgeFindings([], 'error')).toMatchObject({ status: 'pass', findings: { blocking: 0, lower: 0 } });
  });
});

describe('judgeMetric', () => {
  const lt200 = [{ op: '<' as const, value: 200 }];
  const judge = (values: number[], thresholds = lt200) => judgeMetric({ name: 'p95_ms', values, thresholds });
  it('passes when every run is inside the threshold, and reports the median', () => {
    expect(judge([150, 170, 160])).toMatchObject({ status: 'pass', metric: { name: 'p95_ms', value: 160 } });
  });
  it('fails when every run is outside', () => {
    expect(judge([250, 210, 230]).status).toBe('fail');
  });
  it('is unverifiable when runs land on both sides: never the best run', () => {
    const result = judge([150, 250, 160]);
    expect(result.status).toBe('unverifiable');
    expect(result.reason).toContain('150, 250, 160');
  });
  it('every threshold must hold', () => {
    expect(judge([150], [...lt200, { op: '>', value: 160 }]).status).toBe('fail');
  });
  it('without a threshold nothing can be said', () => {
    expect(judge([1], []).status).toBe('unverifiable');
  });
});
