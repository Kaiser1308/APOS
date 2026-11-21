import { describe, expect, it } from 'vitest';
import { applyEvent, type GoalEvent, type GoalState } from './transitions.js';
import { approval, proposal, spec } from './fixtures.test-support.js';
import { InvariantError } from './errors.js';
import { integrationGateProblem } from './integration-gate.js';

let counter = 0;
const event = (type: GoalEvent['type'], data?: unknown): GoalEvent => ({
  id: `IG-${++counter}`,
  goalId: spec.id,
  type,
  data,
  at: '2026-11-21T00:00:00.000Z',
});

describe('an integration gate request', () => {
  const solo = [
    event('goal-drafted', spec),
    event('goal-approved', approval),
    event('goal-selected'),
    event('proposal-drafted', proposal),
  ].reduce<GoalState | undefined>((state, item) => applyEvent(state, item), undefined)!;

  it('names what is wrong for the CLI, and the reducer refuses the same as a defect', () => {
    const commit = 'a'.repeat(40);
    expect(integrationGateProblem(solo, commit, 'why')).toMatch(/not an executing Multi-WP Goal/);
    expect(() => applyEvent(solo, event('integration-gate-requested', { commit, reason: 'why', by: 'lead' }))).toThrow(
      InvariantError,
    );
  });
});
