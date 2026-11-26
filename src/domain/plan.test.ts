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

const oos = {
  ...accept,
  disposition: 'excluded',
  exclusion: { kind: 'out-of-scope' },
  exclusionReason: 'not needed',
} as const;

describe('buildPlan deferral chain does not depend on Goal ID order', () => {
  it('honours an out-of-scope exclusion in the Goal deferred to, even when its ID sorts first', () => {
    const goals = [goal('GOAL-A', SHA_A, 'closed', [oos]), goal('GOAL-Z', SHA_A, 'closed', [deferTo('GOAL-A')])];
    const [row] = buildPlan(goals).requirements;
    expect(row?.status).toBe('out-of-scope');
    expect(row?.goalId).toBe('GOAL-A');
    expect(orphanRequirements(goals)).toEqual([]);
  });

  it('gives the same answer in the reverse ID order', () => {
    const goals = [goal('GOAL-A', SHA_A, 'closed', [deferTo('GOAL-Z')]), goal('GOAL-Z', SHA_A, 'closed', [oos])];
    const [row] = buildPlan(goals).requirements;
    expect(row?.status).toBe('out-of-scope');
    expect(orphanRequirements(goals)).toEqual([]);
  });

  it('terminates on a deferral cycle', () => {
    const goals = [
      goal('GOAL-A', SHA_A, 'closed', [deferTo('GOAL-Z')]),
      goal('GOAL-Z', SHA_A, 'closed', [deferTo('GOAL-A')]),
    ];
    const plan = buildPlan(goals);
    expect(plan.requirements).toHaveLength(1);
    expect(plan.requirements[0]?.status).toBe('orphan');
  });
});

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

describe('explicit adoption across briefs', () => {
  it('clears an orphan only for the explicitly referenced source, including scoped plans', () => {
    const adoption = { ...accept, adopts: { sourceSha256: SHA_B, requirementId: 'R-1' } };
    const goals = [
      goal('GOAL-A', SHA_A, 'closed', [deferTo('GOAL-X')]),
      goal('GOAL-B', SHA_B, 'closed', [deferTo('GOAL-X')]),
      goal('GOAL-X', SHA_A, 'closed', []),
      goal('GOAL-C', 'c'.repeat(64), 'approved', [adoption]),
    ];
    expect(buildPlan(goals, SHA_B).requirements[0]?.status).toBe('planned');
    expect(orphanRequirements(goals).map(r => r.fromGoalId)).toEqual(['GOAL-A']);
  });

  it('honours an explicit out-of-scope adoption in a new brief', () => {
    const goals = [
      goal('GOAL-B', SHA_B, 'closed', [deferTo('GOAL-X')]),
      goal('GOAL-X', SHA_A, 'closed', []),
      goal('GOAL-C', 'c'.repeat(64), 'approved', [{ ...oos, adopts: { sourceSha256: SHA_B, requirementId: 'R-1' } }]),
    ];
    expect(buildPlan(goals, SHA_B).requirements[0]?.status).toBe('out-of-scope');
    expect(orphanRequirements(goals)).toEqual([]);
  });
});
