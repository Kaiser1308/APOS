import { describe, expect, it } from 'vitest';
import { reviewTestsCheck } from './assurance.js';
import { buildAssuranceReport, renderAssuranceText } from './assurance-report.js';
import { blockReason, parseReviewBlocked, reviewOverrideBy, reviewRef } from './review-tests.js';
import { approval, BASE, proposal, soloGreen, spec } from './fixtures.test-support.js';
import { applyEvent, type GoalEventType, type GoalState } from './transitions.js';

const D = 'd'.repeat(40);
const R = 'e'.repeat(40);
const test = { part: 'app', layer: 'L1', id: 'suite::negative' } as const;
const block = {
  packageId: 'WP-MAIN',
  deliveryCommit: D,
  reviewCommit: R,
  files: { 'tests/test_review.py': 'a'.repeat(64) },
  tests: [test],
  blocking: [test],
  alsoRedBefore: [],
  by: 'reviewer',
};

function verified(): GoalState {
  let state: GoalState | undefined;
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) => {
    state = applyEvent(state, { id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  };
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  add('proposal-drafted', { ...proposal, baseCommit: BASE });
  add('proposal-approved');
  for (const event of soloGreen(D)) add(event.type, event.data);
  return state!;
}
const apply = (state: GoalState, type: GoalEventType, data: unknown) =>
  applyEvent(state, { id: 'EV-X', goalId: spec.id, type, data, at: '2026-11-07T01:00:00.000Z' });

describe('review-blocked', () => {
  it('puts the green package back to red, spends an attempt, and the Goal is executing again', () => {
    const before = verified();
    expect(before.status).toBe('verified');
    const after = apply(before, 'review-blocked', block);
    expect(after.status).toBe('executing');
    expect(after.verifiedCommit).toBeUndefined();
    expect(after.packages?.['WP-MAIN']).toMatchObject({
      status: 'red',
      attempts: 1,
      finding: 'blocked by review: suite::negative',
    });
    expect(after.reviewTests).toHaveLength(1);
  });

  it('refuses a review of a commit that is not the latest gated one, or of an unknown package', () => {
    expect(() => apply(verified(), 'review-blocked', { ...block, deliveryCommit: 'c'.repeat(40) })).toThrow(
      /latest gated commit/,
    );
    expect(() => apply(verified(), 'review-blocked', { ...block, packageId: 'WP-NOPE' })).toThrow();
  });

  it('blocks the Goal when the reviews pass the approved attempts', () => {
    let state = verified();
    state = { ...state, appetite: { ...state.appetite!, maxAttempts: 1 } };
    state = apply(state, 'review-blocked', block);
    expect(state.status).toBe('executing');
    state = apply({ ...state, status: 'verified' }, 'review-blocked', { ...block, reviewCommit: 'f'.repeat(40) });
    expect(state.status).toBe('blocked');
  });

  it('says when the test was red before the Goal too, and still blocks', () => {
    const data = parseReviewBlocked({ ...block, alsoRedBefore: [test] });
    expect(blockReason(data)).toBe(
      'blocked by review: suite::negative (also red before the Goal: may be an existing defect)',
    );
    expect(apply(verified(), 'review-blocked', data).packages?.['WP-MAIN']?.status).toBe('red');
  });

  it('blocks the integration commit of a Multi-WP Goal: it must be integrated again', () => {
    const state = { ...verified(), integration: { commitRef: D } };
    const integration = { ...block, packageId: undefined };
    const after = apply(state, 'review-blocked', integration);
    expect(after).toMatchObject({ status: 'executing', integration: undefined, gate: undefined });
    expect(after.packages?.['WP-MAIN']?.status).toBe('green');
    expect(() =>
      apply({ ...state, integration: { commitRef: 'c'.repeat(40) } }, 'review-blocked', integration),
    ).toThrow(/not of the integration commit/);
  });

  it('needs at least one blocking test', () => {
    expect(() => parseReviewBlocked({ ...block, blocking: [] })).toThrow();
  });
});

describe('the review check of a delivery', () => {
  const review = parseReviewBlocked(block);
  const same = { 'tests/test_review.py': 'a'.repeat(64) };
  const check = (input: { files?: Record<string, string | undefined>; status?: 'pass' | 'fail'; by?: string }) =>
    reviewTestsCheck({
      reviews: [review],
      overriddenBy: () => input.by,
      deliveryFiles: () => input.files ?? same,
      delivery: input.status ? { 'app.L1::suite::negative': input.status } : {},
    });

  it('passes when the file is unchanged and the test passes', () => {
    expect(check({ status: 'pass' })).toMatchObject({ status: 'pass' });
  });
  it('fails for a changed or missing file, a failing test, or a test that is not in the report', () => {
    expect(check({ status: 'pass', files: { 'tests/test_review.py': 'b'.repeat(64) } }).reason).toContain('modified');
    expect(check({ status: 'pass', files: { 'tests/test_review.py': undefined } }).reason).toContain('missing');
    expect(check({ status: 'fail' }).reason).toContain('is fail, not pass');
    expect(check({}).reason).toContain('not in the delivery report');
  });
  it('asks nothing of a block the Lead overrode, and says who', () => {
    const waived = check({ by: 'agent:lead' });
    expect(waived.status).toBe('pass');
    expect(waived.reason).toBe('review bị bỏ qua: suite::negative, duyệt bởi agent:lead');
  });
});

describe('the assurance table', () => {
  it('names the blocks and the ones that were overridden', () => {
    let state = apply(verified(), 'review-blocked', block);
    expect(reviewOverrideBy(state, state.reviewTests![0]!)).toBeUndefined();
    expect(renderAssuranceText(buildAssuranceReport(state))).toContain('Review chặn');
    state = apply(state, 'exception-approved', {
      kind: 'review-overridden',
      ref: reviewRef(block, spec.id),
      commit: R,
      reason: 'out of scope',
      by: 'agent:lead',
    });
    const text = renderAssuranceText(buildAssuranceReport(state));
    expect(text).toContain('review bị bỏ qua: suite::negative, duyệt bởi agent:lead');
  });
  it('says nothing about reviews when none blocked', () => {
    expect(renderAssuranceText(buildAssuranceReport(verified()))).not.toContain('Review chặn');
  });
});
