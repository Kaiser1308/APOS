import { describe, expect, it } from 'vitest';
import { applyEvent, type GoalEvent, type GoalEventType, type GoalState } from './transitions.js';
import { approval, proposal, spec } from './fixtures.test-support.js';
import { gateWarnings, reviewReasons } from './reviews.js';

let n = 0;
const event = (type: GoalEventType, data?: unknown): GoalEvent => ({
  id: `EV-${++n}`,
  goalId: spec.id,
  type,
  data,
  at: '2026-11-08T00:00:00.000Z',
});
const run = (...events: GoalEvent[]) =>
  events.reduce<GoalState | undefined>((state, item) => applyEvent(state, item), undefined)!;
const planned = (overrides: Record<string, unknown> = {}) =>
  run(
    event('goal-drafted', spec),
    event('goal-approved', approval),
    event('goal-selected'),
    event('proposal-drafted', { ...proposal, ...overrides }),
  );

describe('Gate A: the Human approves WHAT with a controller-only appetite', () => {
  it('refuses approval without an appetite', () => {
    const draft = run(event('goal-drafted', spec));
    expect(() => applyEvent(draft, event('goal-approved'))).toThrow(/appetite/);
  });
  it('keeps the appetite out of the Goal spec that owners read', () => {
    const state = run(event('goal-drafted', spec), event('goal-approved', approval));
    expect(state.appetite?.maxAttempts).toBe(3);
    expect(JSON.stringify(state.spec)).not.toMatch(/maxSpend|appetite/);
  });
});

describe('No Human gate on HOW: the controller machine-checks the Lead plan', () => {
  it('accepts a plan that fits the approved Goal and appetite', () => {
    expect(applyEvent(planned(), event('proposal-approved')).status).toBe('executing');
  });
  it('refuses a plan made against another source snapshot', () => {
    expect(() => applyEvent(planned({ sourceSha256: 'f'.repeat(64) }), event('proposal-approved'))).toThrow(
      /different source/,
    );
  });
  it('sends an estimate over the appetite to a Human decision instead of starting', () => {
    expect(() =>
      applyEvent(planned({ estimatedCost: { spendUsd: 5, wallMinutes: 600 } }), event('proposal-approved')),
    ).toThrow(/needs-decision/);
  });
  it('requires a split rationale and estimate for Multi-WP', () => {
    expect(() => planned({ mode: 'multi-wp', splitRationale: undefined })).toThrow(/split rationale/);
  });
});

describe('findings and review warnings', () => {
  const executing = () => applyEvent(planned(), event('proposal-approved'));
  it('parks the Goal for PM and Human on an intent gap instead of retrying', () => {
    const state = applyEvent(
      executing(),
      event('finding-recorded', { kind: 'intent_gap', note: 'Source is silent on reused QR codes', by: 'lead' }),
    );
    expect(state).toMatchObject({ status: 'blocked', blocker: { kind: 'product' } });
  });
  it('warns when the gated diff changes tests, even with no declared risk, and says tests are not locked yet', () => {
    const input = { spec, proposal, changedFiles: ['src/checkin.ts', 'src/checkin.test.ts'] };
    expect(reviewReasons(input)).toEqual(['tests or oracles changed: src/checkin.test.ts (not locked before phase 3)']);
    expect(gateWarnings(input)[0]).toMatch(/^needs attention: tests or oracles changed/);
    expect(reviewReasons({ ...input, changedFiles: ['src/checkin.ts'] })).toEqual([]);
  });
  it('warns when the diff changes a file a check runs, or a build manifest', () => {
    const harness = { ...spec, checks: [{ ...spec.checks[0], command: 'node ./harness.js' }] };
    expect(reviewReasons({ spec: harness, changedFiles: ['harness.js'] })[0]).toMatch(
      /files the checks run .*harness.js/,
    );
    expect(reviewReasons({ spec, changedFiles: ['package.json'] })[0]).toMatch(/package.json/);
  });
  it('warns on shared interface paths and declared risks', () => {
    const risky = { ...proposal, risks: ['Auth regression'], sharedPaths: ['src/api'] };
    const reasons = reviewReasons({ spec, proposal: risky, changedFiles: ['src/api/schema.ts'] });
    expect(reasons.join('|')).toMatch(/declared risks.*shared interface paths changed: src\/api\/schema.ts/);
  });
  it('records a review as advice only: it blocks nothing and needs no separate session', () => {
    const state = applyEvent(
      executing(),
      event('review-submitted', {
        subject: 'goal',
        reviewer: 'anyone',
        session: 'any',
        result: 'changes',
        commitRef: 'a'.repeat(40),
        note: 'consider a rename',
      }),
    );
    expect(state.reviews).toHaveLength(1);
    expect(state.status).toBe('executing');
  });
});
