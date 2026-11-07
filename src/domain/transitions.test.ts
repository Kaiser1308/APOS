import { describe, expect, it } from 'vitest';
import { applyEvent, type GoalEvent, type GoalState } from './transitions.js';
import { spec, proposal } from './fixtures.test-support.js';
let counter = 0;
const event = (type: GoalEvent['type'], data?: unknown): GoalEvent => ({ id: `EV-${++counter}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
const start = (): GoalState => applyEvent(undefined, event('goal-drafted', spec));

describe('approval gates', () => {
  it('does not permit execution after Goal approval alone', () => {
    const approved = applyEvent(start(), event('goal-approved'));
    expect(() => applyEvent(approved, event('execution-started'))).toThrow();
  });
  it('permits execution only after selection and current proposal approval', () => {
    let state = applyEvent(start(), event('goal-approved'));
    state = applyEvent(state, event('goal-selected'));
    state = applyEvent(state, event('proposal-drafted', proposal));
    state = applyEvent(state, event('proposal-approved'));
    expect(applyEvent(state, event('execution-started')).status).toBe('executing');
  });
  it('invalidates plan approval and evidence after Goal revision', () => {
    let state = applyEvent(start(), event('goal-approved'));
    state = applyEvent(state, event('goal-selected'));
    state = applyEvent(state, event('proposal-drafted', proposal));
    state = applyEvent(state, event('proposal-approved'));
    state = applyEvent(state, event('goal-revised', { ...spec, version: 2 }));
    expect(state.proposalApprovedVersion).toBeUndefined();
    expect(() => applyEvent(state, event('execution-started'))).toThrow();
  });
  it('does not restart a closed Goal', () => {
    let state = applyEvent(start(), event('goal-approved'));
    state = applyEvent(state, event('goal-selected'));
    state = applyEvent(state, event('proposal-drafted', proposal));
    state = applyEvent(state, event('proposal-approved'));
    state = applyEvent(state, event('execution-started'));
    state = applyEvent(state, event('verified'));
    state = applyEvent(state, event('outcome-accepted'));
    expect(() => applyEvent(state, event('execution-started'))).toThrow();
  });
  it('records a blocker and requires an explicit unblock event to resume', () => {
    let state = applyEvent(start(), event('goal-approved'));
    state = applyEvent(state, event('goal-selected'));
    state = applyEvent(state, event('proposal-drafted', proposal));
    state = applyEvent(state, event('proposal-approved'));
    state = applyEvent(state, event('execution-started'));
    state = applyEvent(state, event('blocked', { kind: 'external', note: 'API unavailable' }));
    expect(state.status).toBe('blocked');
    expect(() => applyEvent(state, event('verified'))).toThrow();
    state = applyEvent(state, event('decision-logged', { note: 'API restored' }));
    expect(state.status).toBe('blocked');
    expect(applyEvent(state, event('unblocked')).status).toBe('executing');
  });
  it('holds Multi-WP packages as versioned Goal-owned state', () => {
    let state = applyEvent(start(), event('goal-approved'));
    state = applyEvent(state, event('goal-selected'));
    state = applyEvent(state, event('proposal-drafted', { ...proposal, mode: 'multi-wp' }));
    state = applyEvent(state, event('proposal-approved'));
    const wp = {
      id: 'WP-01', goalId: spec.id, goalVersion: 1, version: 1,
      owner: 'worker-a', outcome: 'QR intake works', scope: ['scanner'], exclusions: [],
      dependencies: [], interfaces: ['checkIn(token) -> result'],
      acceptance: [{ id: 'WP-AC-1', text: 'valid token checks in', goalAcceptanceId: 'AC-1' }],
      integration: 'Lead runs check-in flow'
    };
    state = applyEvent(state, event('package-added', wp));
    expect(state.packages?.['WP-01']?.spec.version).toBe(1);
    expect(() => applyEvent(state, event('package-added', wp))).toThrow(/already exists/i);
  });
});
