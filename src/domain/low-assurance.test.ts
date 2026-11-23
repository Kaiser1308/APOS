import { describe, expect, it } from 'vitest';
import { applyEvent, type GoalState } from './transitions.js';
import { buildAssuranceReport, renderAssuranceText } from './assurance-report.js';
import { approval, spec } from './fixtures.test-support.js';
import type { GoalEvent } from './transitions.js';

let n = 0;
const event = (type: GoalEvent['type'], data?: unknown): GoalEvent => ({
  id: `E${++n}`,
  goalId: spec.id,
  type,
  data,
  at: '2026-11-23T00:00:00.000Z',
});
const approved = (extra: object = {}): GoalState =>
  [event('goal-drafted', spec), event('goal-approved', { ...approval, setupVersion: 1, ...extra })].reduce(
    (state: GoalState | undefined, item) => applyEvent(state, item),
    undefined,
  )!;

describe('the low-assurance label of a Goal', () => {
  it('is taken from the approval of the Goal, so it is in the log and every reader sees it', () => {
    expect(approved({ baselineMissing: ['app.L1', 'app.L2'] }).baselineMissing).toEqual(['app.L1', 'app.L2']);
    expect(approved().baselineMissing).toBeUndefined();
  });
  it('refuses a label that is not a list of layer names', () => {
    expect(() => approved({ baselineMissing: 'app.L1' })).toThrow(/baselineMissing/);
    expect(() => approved({ baselineMissing: [] })).toThrow(/baselineMissing/);
  });
  it('is the first line of the assurance table, before the Goal id, and changes nothing else', () => {
    const plain = renderAssuranceText(buildAssuranceReport(approved()));
    const labelled = renderAssuranceText(buildAssuranceReport(approved({ baselineMissing: ['app.L1', 'app.L2'] })));
    const [first, ...rest] = labelled.split('\n');
    expect(first).toBe('BẢO ĐẢM THẤP: repo chưa có test nền (app.L1, app.L2)');
    expect(rest.join('\n')).toBe(plain);
    expect(buildAssuranceReport(approved({ baselineMissing: ['app.L1'] })).lowAssurance).toEqual(['app.L1']);
  });
});
