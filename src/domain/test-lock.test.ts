import { describe, expect, it } from 'vitest';
import { applyEvent, type GoalEvent, type GoalState } from './transitions.js';
import { hasException } from './exceptions.js';
import { countAsserts, judgeSuite, lockedTestKeys, testMapSchema } from './test-lock.js';
import { BASE, DELIVERY, approval, proposal, spec } from './fixtures.test-support.js';

let counter = 0;
const event = (type: string, data?: unknown): GoalEvent => ({
  id: `EV-${++counter}`,
  goalId: spec.id,
  type: type as GoalEvent['type'],
  data,
  at: '2026-11-07T00:00:00.000Z',
});
const LOCK = 'c'.repeat(40);
const lockData = (extra: object = {}) => ({
  commit: LOCK,
  files: { 'tests/test_a.py': 'd'.repeat(64) },
  asserts: { 'tests/test_a.py': 2 },
  map: [{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['tests.test_a::test_x'] }],
  by: 'tester',
  ...extra,
});
const planned = (): GoalState => {
  let state = applyEvent(undefined, event('goal-drafted', spec));
  state = applyEvent(state, event('goal-approved', approval));
  state = applyEvent(state, event('goal-selected'));
  return applyEvent(state, event('proposal-drafted', { ...proposal, baseCommit: BASE }));
};
const testing = (): GoalState => applyEvent(planned(), event('proposal-approved', { by: 'lead', testing: true }));

describe('testing stage', () => {
  it("goes to testing only when the Lead's commit says so; an old commit record replays to executing", () => {
    expect(testing().status).toBe('testing');
    expect(testing().packages?.['WP-MAIN']?.status).toBe('pending');
    expect(applyEvent(planned(), event('proposal-approved', { by: 'lead', proposalVersion: 1 })).status).toBe(
      'executing',
    );
    expect(applyEvent(planned(), event('proposal-approved')).status).toBe('executing');
  });
  it('takes no submission while testing', () => {
    const submit = event('package-submitted', {
      packageId: 'WP-MAIN',
      version: 1,
      commit: DELIVERY,
      base: BASE,
      by: 'x',
    });
    expect(() => applyEvent(testing(), submit)).toThrow(/Executing Goal required/);
  });
  it('tests-locked starts execution and keeps the lock', () => {
    const state = applyEvent(testing(), event('tests-locked', lockData()));
    expect(state.status).toBe('executing');
    expect(state.testLock?.commit).toBe(LOCK);
    expect(lockedTestKeys(state.testLock!)).toEqual(['app.L2::tests.test_a::test_x']);
  });
  it('refuses a lock outside testing or executing, and a malformed one', () => {
    expect(() => applyEvent(planned(), event('tests-locked', lockData()))).toThrow();
    expect(() => applyEvent(testing(), event('tests-locked', { ...lockData(), files: { a: 'short' } }))).toThrow();
  });
  it('a revision must name the lock it replaces, and sends every package back to be gated again', () => {
    const locked = applyEvent(testing(), event('tests-locked', lockData()));
    const next = 'e'.repeat(40);
    expect(() => applyEvent(locked, event('tests-locked', lockData({ commit: next })))).toThrow(/name the lock/);
    const revised = applyEvent(locked, event('tests-locked', lockData({ commit: next, revisionOf: LOCK })));
    expect(revised.testLock).toMatchObject({ commit: next, revisionOf: LOCK });
    expect(revised.packages?.['WP-MAIN']?.status).toBe('pending');
  });
  it('a pending revision is kept until a lock replaces it', () => {
    const locked = applyEvent(testing(), event('tests-locked', lockData()));
    const pending = applyEvent(
      locked,
      event('tests-revision-pending', {
        commit: 'e'.repeat(40),
        reason: 'drops a test',
        problems: ['x'],
        by: 'tester',
      }),
    );
    expect(pending.pendingRevision?.reason).toBe('drops a test');
    const next = 'e'.repeat(40);
    expect(
      applyEvent(pending, event('tests-locked', lockData({ commit: next, revisionOf: LOCK }))).pendingRevision,
    ).toBeUndefined();
  });
  it('a new proposal drops the lock: it was made against another plan', () => {
    const locked = applyEvent(testing(), event('tests-locked', lockData()));
    const again = applyEvent(locked, event('proposal-revised', { ...proposal, version: 2, baseCommit: BASE }));
    expect(again.status).toBe('planned');
    expect(again.testLock).toBeUndefined();
  });
});

describe('layers the Lead adds', () => {
  it('a Solo plan carries its layers into WP-MAIN; a plan without them leaves the key out', () => {
    const solo = (extra: object) => {
      let state = applyEvent(undefined, event('goal-drafted', spec));
      state = applyEvent(state, event('goal-approved', approval));
      state = applyEvent(state, event('goal-selected'));
      state = applyEvent(state, event('proposal-drafted', { ...proposal, baseCommit: BASE, ...extra }));
      return applyEvent(state, event('proposal-approved', { by: 'lead' })).packages?.['WP-MAIN']?.spec;
    };
    expect(solo({ layers: { submit: ['L3'] } })?.layers).toEqual({ submit: ['L3'] });
    expect(solo({})).not.toHaveProperty('layers');
  });
});

describe('test map', () => {
  it('accepts L2, L3, L4 entries and refuses L1 or an empty id list', () => {
    const entry = { acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['a'] };
    expect(testMapSchema.safeParse([entry]).success).toBe(true);
    expect(testMapSchema.safeParse([{ ...entry, layer: 'L1' }]).success).toBe(false);
    expect(testMapSchema.safeParse([{ ...entry, testIds: [] }]).success).toBe(false);
  });
});

describe('exceptions', () => {
  const approve = (data: object) => event('exception-approved', { commit: DELIVERY, reason: 'ok', ...data });
  it('records an agent approval with who, and finds it by kind, ref and commit', () => {
    const state = applyEvent(testing(), approve({ kind: 'needs-human', ref: 'WP-MAIN', by: 'agent:lead' }));
    expect(state.exceptions).toHaveLength(1);
    expect(hasException(state, 'needs-human', 'WP-MAIN', DELIVERY)).toBe(true);
    expect(hasException(state, 'needs-human', 'WP-MAIN', 'a'.repeat(39) + 'b')).toBe(false);
    expect(hasException(state, 'tests-weakened', 'WP-MAIN', DELIVERY)).toBe(false);
  });
  it('refuses an approver that is neither an agent nor the Human, and a Human approval with no confirmation', () => {
    expect(() => applyEvent(testing(), approve({ kind: 'needs-human', ref: 'WP-MAIN', by: 'lead' }))).toThrow();
    expect(() => applyEvent(testing(), approve({ kind: 'needs-human', ref: 'WP-MAIN', by: 'human' }))).toThrow(
      /confirmation/,
    );
    expect(
      applyEvent(
        testing(),
        approve({ kind: 'floor-reduced', ref: 'WP-MAIN', by: 'human', confirmation: { by: 'human' } }),
      ).exceptions,
    ).toHaveLength(1);
  });
});

describe('judgeSuite', () => {
  const patterns = { app: { notImplemented: ['NotImplementedError'], loadError: ['ImportError'] } };
  const entry = (testIds: string[], acceptanceId = 'AC-1') => ({
    acceptanceId,
    part: 'app',
    layer: 'L2' as const,
    testIds,
  });
  const judge = (
    tests: { id: string; status: 'pass' | 'fail' | 'error' | 'skip'; message?: string }[],
    proof = 'red-green' as 'red-green' | 'removed',
    ids = ['a'],
  ) =>
    judgeSuite({
      map: [entry(ids)],
      proofOf: () => proof,
      outcomes: [{ part: 'app', layer: 'L2', tests }],
      patterns,
    });
  it('accepts a test that fails, or errors with "not implemented"', () => {
    expect(judge([{ id: 'a', status: 'fail', message: 'assert 1 == 2' }])).toEqual([]);
    expect(judge([{ id: 'a', status: 'error', message: 'NotImplementedError: add' }])).toEqual([]);
  });
  it('holds a removed test to a failed assertion: the feature is still there, an error shows nothing', () => {
    expect(judge([{ id: 'a', status: 'fail', message: 'assert apply_coupon is None' }], 'removed')).toEqual([]);
    expect(judge([{ id: 'a', status: 'pass' }], 'removed')[0]).toMatch(/already green/);
    expect(judge([{ id: 'a', status: 'error', message: 'NotImplementedError: x' }], 'removed')[0]).toMatch(
      /must fail on an assertion.*error/,
    );
    expect(judge([{ id: 'a', status: 'error', message: 'AttributeError: nope' }], 'removed')[0]).toMatch(
      /must fail on an assertion/,
    );
    expect(judge([{ id: 'a', status: 'error', message: 'ImportError while importing' }], 'removed')[0]).toMatch(
      /did not load/,
    );
  });
  it('refuses a removed test that failed with an exception that is not an assertion, as pytest and vitest report it', () => {
    for (const message of [
      "AttributeError: module 'shop.cart' has no attribute 'nope'",
      "ImportError: cannot import name 'nope' from 'shop.cart'",
      'NotImplementedError: add',
      'TypeError: x is not a function',
      'java.lang.NullPointerException: null',
    ])
      expect(judge([{ id: 'a', status: 'fail', message }], 'removed')[0], message).toMatch(
        /must fail on an assertion|did not load/,
      );
  });
  it('accepts a removed test that failed an assertion, however the runner words it', () => {
    for (const message of [
      'assert not True',
      "Failed: DID NOT RAISE <class 'TypeError'>",
      'AssertionError: apply_coupon is still there',
      'expected true to be false // Object.is equality',
      'org.opentest4j.AssertionFailedError: expected: <false> but was: <true>',
    ])
      expect(judge([{ id: 'a', status: 'fail', message }], 'removed'), message).toEqual([]);
  });
  it('names a test that is already green', () => {
    expect(judge([{ id: 'a', status: 'pass' }])).toEqual([
      expect.stringContaining('AC-1 app.L2 a: already green') as unknown,
    ]);
  });
  it('rejects a load error, however it shows (error or fail), even for a test no criterion names', () => {
    expect(judge([{ id: 'a', status: 'error', message: 'ImportError while importing test module' }])[0]).toMatch(
      /did not load/,
    );
    expect(
      judge([
        { id: 'a', status: 'fail', message: 'assert' },
        { id: 'broken', status: 'fail', message: 'ImportError: no_such' },
      ]),
    ).toEqual([expect.stringContaining('broken: the test did not load') as unknown]);
  });
  it('rejects an error that is not "not implemented" (a syntax error, a typo)', () => {
    expect(judge([{ id: 'a', status: 'error', message: 'NameError: x is not defined' }])[0]).toMatch(
      /errored with something other than "not implemented": NameError/,
    );
  });
  it('rejects a test missing from the report and a skipped one', () => {
    expect(judge([], 'red-green')[0]).toMatch(/AC-1 app.L2 a: not in the report/);
    expect(judge([{ id: 'a', status: 'skip' }])[0]).toMatch(/skipped/);
  });
  it('wants a stays-green test to pass', () => {
    expect(judge([{ id: 'a', status: 'pass' }], 'stays-green')).toEqual([]);
    expect(judge([{ id: 'a', status: 'fail' }], 'stays-green')[0]).toMatch(/must pass, it is fail/);
  });
  it('reports every problem at once', () => {
    expect(judge([{ id: 'a', status: 'pass' }], 'red-green', ['a', 'b'])).toHaveLength(2);
  });
});

describe('countAsserts', () => {
  it('counts lines that match, not occurrences', () => {
    expect(countAsserts('assert a\n  assert b\nx = 1\nassert c; assert d\n', ['^\\s*assert\\b'])).toBe(3);
  });
});
