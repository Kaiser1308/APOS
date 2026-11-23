import { describe, expect, it } from 'vitest';
import { buildAssuranceReport, renderAssuranceText } from './assurance-report.js';
import { gateReport, spec } from './fixtures.test-support.js';
import type { CheckResult } from './gate.js';
import type { GoalState } from './transitions.js';
import type { TestLock } from './test-lock.js';

const check = (status: CheckResult['status'], extra: Partial<CheckResult> = {}): CheckResult => ({
  checkId: 'APOS-CHARACTERIZED',
  status,
  reason: 'r',
  base: [],
  delivery: [],
  newFailures: [],
  ...extra,
});
const refactor = { ...spec, kind: 'refactor' as const, paths: ['legacy/**'], acceptance: [], checks: [] };
const state = (extra: Partial<GoalState>): GoalState => ({
  spec: refactor,
  status: 'executing',
  selected: true,
  evidence: [],
  reviews: [],
  setupVersion: 1,
  ...extra,
});
const gate = (checks: CheckResult[]) => ({
  ...gateReport(),
  baseCommit: 'a'.repeat(40),
  deliveryCommit: 'b'.repeat(40),
  checks,
});
const line = (text: string, name: string) => text.split('\n').find(item => item.trim().startsWith(name));

describe('the assurance table of a refactor', () => {
  it('says what it kept once the gate found the captured tests green before and after', () => {
    const passed = check('pass', { preserved: { tests: 12, from: ['GOAL-001', 'GOAL-002'] } });
    const report = buildAssuranceReport(state({ gate: gate([passed]) }));
    expect(report.preserved).toEqual({
      proven: true,
      tests: 12,
      from: ['GOAL-001', 'GOAL-002'],
      base: 'aaaaaaa',
      after: 'bbbbbbb',
    });
    expect(line(renderAssuranceText(report), 'Giữ hành vi')).toContain(
      'giữ nguyên hành vi: 12 test chụp từ GOAL-001, GOAL-002, xanh trước trên aaaaaaa, xanh sau trên bbbbbbb',
    );
  });
  it('does not claim it when the gate is red or has not run', () => {
    expect(buildAssuranceReport(state({})).preserved).toEqual({ proven: false });
    const red = buildAssuranceReport(state({ gate: gate([check('fail')]) }));
    expect(red.preserved).toEqual({ proven: false });
    expect(line(renderAssuranceText(red), 'Giữ hành vi')).toContain('chưa chứng minh');
  });
  it('prefers the close gate, which ran on the verified commit', () => {
    const close = {
      ...gate([check('pass', { preserved: { tests: 3, from: ['GOAL-009'] } })]),
      phase: 'close' as const,
    };
    const report = buildAssuranceReport(
      state({ gate: gate([check('pass', { preserved: { tests: 2, from: ['GOAL-001'] } })]), closeGate: close }),
    );
    expect(report.preserved).toMatchObject({ tests: 3, from: ['GOAL-009'] });
  });
  it('has no such line for another kind of Goal', () => {
    expect(buildAssuranceReport({ ...state({}), spec }).preserved).toBeUndefined();
    expect(renderAssuranceText(buildAssuranceReport({ ...state({}), spec }))).not.toContain('Giữ hành vi');
  });
});

describe('the assurance table of a characterize Goal', () => {
  it('says what it captures and how many tests it has locked', () => {
    const goal = { ...spec, kind: 'characterize' as const, covers: ['legacy/pricing.py'] };
    const lock = { map: [{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['a', 'b', 'c'] }] } as TestLock;
    const report = buildAssuranceReport({ ...state({}), spec: goal, testLock: lock });
    expect(report.captured).toEqual({ covers: ['legacy/pricing.py'], tests: 3 });
    expect(line(renderAssuranceText(report), 'Chụp hành vi')).toContain('3 test đã khoá');
    expect(line(renderAssuranceText(report), 'Chụp hành vi')).toContain('legacy/pricing.py');
  });
});
