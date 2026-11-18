import { describe, expect, it } from 'vitest';
import type { GoalSpec } from './contracts.js';
import { spec } from './fixtures.test-support.js';
import { buildPlan, orphanRequirements } from './plan.js';
import type { GoalState, GoalStatus } from './transitions.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const goal = (id: string, sha: string, status: GoalStatus, requirements: GoalSpec['requirements']): GoalState => ({
  spec: { ...spec, id, source: { ...spec.source, sha256: sha }, requirements },
  status,
  selected: false,
  evidence: [],
  reviews: [],
});
const accept = { id: 'R-1', sourceSpan: 'line 3', text: 'same id', disposition: 'acceptance' } as const;
const deferTo = (to: string) =>
  ({
    ...accept,
    disposition: 'excluded',
    exclusion: { kind: 'deferred', to },
    exclusionReason: 'later',
  }) as const;

describe('buildPlan with two sources sharing a requirement id', () => {
  const goals = [
    goal('GOAL-A1', SHA_A, 'closed', [accept]),
    goal('GOAL-B1', SHA_B, 'closed', [deferTo('GOAL-B2')]),
    goal('GOAL-B2', SHA_B, 'closed', []),
  ];

  it('does not let a closed R-1 of one source hide an orphan R-1 of the other', () => {
    const plan = buildPlan(goals);
    expect(plan.requirements.filter(r => r.id === 'R-1').map(r => [r.sourceSha256, r.status])).toEqual([
      [SHA_A, 'covered'],
      [SHA_B, 'orphan'],
    ]);
    expect(orphanRequirements(goals).map(o => o.fromGoalId)).toEqual(['GOAL-B1']);
  });

  it('is scoped to the given source', () => {
    const plan = buildPlan(goals, SHA_B);
    expect(plan.requirements.map(r => [r.sourceSha256, r.status])).toEqual([[SHA_B, 'orphan']]);
    expect(plan.goals.map(g => g.id)).toEqual(['GOAL-B1', 'GOAL-B2']);
  });
});
