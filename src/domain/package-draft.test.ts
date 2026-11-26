import { describe, expect, it } from 'vitest';
import { applyEvent, type GoalEvent, type GoalState } from './transitions.js';
import { approval, proposal, spec } from './fixtures.test-support.js';
import { testPlanProblems } from './test-plan.js';

let sequence = 0;
const event = (type: GoalEvent['type'], data?: unknown): GoalEvent => ({
  id: `EV-${++sequence}`,
  goalId: spec.id,
  type,
  data,
  at: '2026-11-07T00:00:00.000Z',
});
const wp = (id: string) => ({
  id,
  goalId: spec.id,
  goalVersion: 1,
  version: 1,
  owner: 'worker',
  outcome: 'outcome',
  scope: ['scope'],
  exclusions: [],
  dependencies: [],
  interfaces: ['api@v1'],
  acceptance: [{ id: `${id}-AC`, text: 'works', goalAcceptanceId: 'AC-1' }],
  integration: 'integrate',
});
const draft = (): GoalState => {
  let state = applyEvent(undefined, event('goal-drafted', spec));
  state = applyEvent(state, event('goal-approved', approval));
  state = applyEvent(state, event('goal-selected'));
  state = applyEvent(state, event('proposal-drafted', { ...proposal, mode: 'multi-wp' }));
  state = applyEvent(state, event('package-added', wp('WP-01')));
  return applyEvent(state, event('package-added', wp('WP-02')));
};

describe('Multi-WP draft correction', () => {
  it('revises duplicate criterion coverage before committing the plan', () => {
    let state = draft();
    const problems = () =>
      testPlanProblems({
        goal: state.spec,
        proposal: state.proposal!,
        packages: Object.values(state.packages!).map(p => p.spec),
        pinned: false,
      });
    expect(problems()).toContainEqual(expect.stringMatching(/AC-1 belongs to 2 packages/));
    state = applyEvent(
      state,
      event('package-revised', {
        spec: { ...wp('WP-02'), version: 2, acceptance: [{ id: 'WP-02-AC', text: 'other work' }] },
        reason: 'correct coverage',
      }),
    );
    expect(problems()).toEqual([]);
    expect(applyEvent(state, event('proposal-approved')).status).toBe('executing');
  });
  it('removes a draft package even when the graph is temporarily incomplete', () => {
    const state = applyEvent(draft(), event('package-removed', { packageId: 'WP-02', reason: 'replace draft' }));
    expect(Object.keys(state.packages!)).toEqual(['WP-01']);
    expect(() => applyEvent(state, event('proposal-approved'))).toThrow(/at least two packages/i);
  });
  it('keeps the acceptance mapping locked after the proposal is committed', () => {
    let state = draft();
    state = applyEvent(state, event('proposal-approved'));
    expect(() =>
      applyEvent(
        state,
        event('package-revised', {
          spec: { ...wp('WP-02'), version: 2, acceptance: [{ id: 'WP-02-AC', text: 'other work' }] },
          reason: 'change coverage',
        }),
      ),
    ).toThrow(/Goal reapproval required/);
  });
});
