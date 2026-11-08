import { describe, expect, it } from 'vitest';
import { applyEvent, type GoalEvent, type GoalEventType, type GoalState } from './transitions.js';
import { approval, gateReport, proposal, spec, DELIVERY } from './fixtures.test-support.js';
import { reviewReasons } from './reviews.js';
import { attemptKey } from './gate.js';

let n = 0;
const event = (type: GoalEventType, data?: unknown): GoalEvent => ({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-08T00:00:00.000Z' });
const run = (...events: GoalEvent[]) => events.reduce<GoalState | undefined>((state, item) => applyEvent(state, item), undefined)!;
const planned = (overrides: Record<string, unknown> = {}) => run(event('goal-drafted', spec), event('goal-approved', approval), event('goal-selected'), event('proposal-drafted', { ...proposal, ...overrides }));

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
    expect(applyEvent(planned(), event('proposal-approved')).status).toBe('ready');
  });
  it('refuses a plan made against another source snapshot', () => {
    expect(() => applyEvent(planned({ sourceSha256: 'f'.repeat(64) }), event('proposal-approved'))).toThrow(/different source/);
  });
  it('sends an estimate over the appetite to a Human decision instead of dispatching', () => {
    expect(() => applyEvent(planned({ estimatedCost: { spendUsd: 50, wallMinutes: 30 } }), event('proposal-approved'))).toThrow(/needs-decision/);
  });
  it('requires a split rationale and estimate for Multi-WP', () => {
    expect(() => planned({ mode: 'multi-wp', splitRationale: undefined })).toThrow(/split rationale/);
  });
});

describe('findings and review', () => {
  const executing = () => applyEvent(applyEvent(planned(), event('proposal-approved')), event('execution-started', { runId: 'run_1', dispatchId: 'ctx_1' }));
  it('parks the Goal for PM and Human on an intent gap instead of retrying', () => {
    const state = applyEvent(executing(), event('finding-recorded', { kind: 'intent_gap', note: 'Source is silent on reused QR codes', by: 'lead' }));
    expect(state).toMatchObject({ status: 'blocked', blocker: { kind: 'product' } });
  });
  it('requires review when the gated diff changes tests, even with no declared risk', () => {
    const state = executing();
    const gate = { ...gateReport(DELIVERY), attemptKey: attemptKey(state), changedFiles: ['src/checkin.ts', 'src/checkin.test.ts'] };
    const gated = applyEvent(state, event('gate-recorded', gate));
    expect(reviewReasons(gated)).toEqual(['tests or oracles changed: src/checkin.test.ts']);
    expect(reviewReasons(applyEvent(state, event('gate-recorded', { ...gate, changedFiles: ['src/checkin.ts'] })))).toEqual([]);
  });
  it('requires review when the diff changes a file a check runs, or a build manifest', () => {
    const state = executing();
    const gated = (files: string[]) => applyEvent(state, event('gate-recorded', { ...gateReport(DELIVERY), attemptKey: attemptKey(state), changedFiles: files }));
    const npmTest = { ...state, spec: { ...state.spec, checks: [{ ...state.spec.checks[0], command: 'node ./harness.js' }] } };
    expect(reviewReasons({ ...gated(['harness.js']), spec: npmTest.spec })[0]).toMatch(/files the checks run .*harness.js/);
    expect(reviewReasons(gated(['package.json']))[0]).toMatch(/package.json/);
  });
  it('rejects a reviewer reusing the owner session', () => {
    const state = executing();
    const gated = applyEvent(state, event('gate-recorded', { ...gateReport(DELIVERY), attemptKey: attemptKey(state) }));
    expect(() => applyEvent(gated, event('review-submitted', { subject: 'goal', reviewer: 'someone-else', session: 'ctx_1', result: 'pass', commitRef: DELIVERY, note: 'x' }))).toThrow(/separate from every owner/);
  });
});
