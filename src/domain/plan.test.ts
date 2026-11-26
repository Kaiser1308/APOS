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

  it.each(['stopped', 'approved', 'closed'] as const)(
    'reports the original orphan when an adopting Goal is %s unless it handles the requirement',
    status => {
      const goals = [
        goal('GOAL-A', SHA_A, 'closed', [deferTo('GOAL-B')]),
        goal('GOAL-B', SHA_A, 'closed', []),
        goal('GOAL-C', SHA_B, status, [{ ...accept, adopts: { sourceSha256: SHA_A, requirementId: 'R-1' } }]),
      ];
      const row = buildPlan(goals, SHA_A).requirements[0];
      expect(row?.status).toBe(status === 'stopped' ? 'orphan' : status === 'closed' ? 'covered' : 'planned');
      expect(orphanRequirements(goals)).toEqual(
        status === 'stopped'
          ? [
              {
                id: 'R-1',
                text: 'same id',
                fromGoalId: 'GOAL-A',
                targetGoalId: 'GOAL-B',
                sourceSha256: SHA_A,
                sourcePath: spec.source.path,
              },
            ]
          : [],
      );
    },
  );

  it('preserves the most recent deferral when a later adoption is stopped', () => {
    const goals = [
      goal('GOAL-A', SHA_A, 'closed', [deferTo('GOAL-B')]),
      goal('GOAL-B', SHA_A, 'closed', []),
      goal('GOAL-C', SHA_B, 'closed', [
        { ...deferTo('GOAL-D'), adopts: { sourceSha256: SHA_A, requirementId: 'R-1' } },
      ]),
      goal('GOAL-D', SHA_B, 'closed', []),
      goal('GOAL-E', 'c'.repeat(64), 'stopped', [{ ...accept, adopts: { sourceSha256: SHA_B, requirementId: 'R-1' } }]),
    ];
    expect(buildPlan(goals, SHA_A).requirements[0]).toMatchObject({
      status: 'orphan',
      fromGoalId: 'GOAL-C',
      goalId: 'GOAL-D',
    });
  });

  it('reports one orphan per deferred requirement across a long adoption chain', () => {
    const goals = [
      goal('GOAL-A', SHA_A, 'closed', [deferTo('GOAL-B')]),
      goal('GOAL-B', SHA_A, 'closed', []),
      goal('GOAL-C', SHA_B, 'closed', [
        { ...deferTo('GOAL-D'), adopts: { sourceSha256: SHA_A, requirementId: 'R-1' } },
      ]),
      goal('GOAL-D', SHA_B, 'closed', []),
      goal('GOAL-E', 'c'.repeat(64), 'closed', [
        { ...deferTo('GOAL-F'), adopts: { sourceSha256: SHA_B, requirementId: 'R-1' } },
      ]),
      goal('GOAL-F', SHA_B, 'closed', []),
      goal('GOAL-G', 'd'.repeat(64), 'closed', [deferTo('GOAL-H')]),
      goal('GOAL-H', SHA_B, 'closed', []),
    ];
    expect(orphanRequirements(goals)).toEqual([
      {
        id: 'R-1',
        text: 'same id',
        fromGoalId: 'GOAL-E',
        targetGoalId: 'GOAL-F',
        sourceSha256: 'c'.repeat(64),
        sourcePath: spec.source.path,
      },
      {
        id: 'R-1',
        text: 'same id',
        fromGoalId: 'GOAL-G',
        targetGoalId: 'GOAL-H',
        sourceSha256: 'd'.repeat(64),
        sourcePath: spec.source.path,
      },
    ]);
  });

  it.each([false, true])(
    'reports the actual deferred ID and source regardless of Goal order (reversed: %s)',
    reverse => {
      const goals = [
        goal('GOAL-A', SHA_A, 'closed', [{ ...deferTo('GOAL-B'), id: 'R-11' }]),
        goal('GOAL-B', SHA_A, 'closed', []),
        goal('GOAL-C', SHA_B, 'closed', [
          {
            ...deferTo('GOAL-D'),
            id: 'R-22',
            text: 'new brief text',
            adopts: { sourceSha256: SHA_A, requirementId: 'R-11' },
          },
        ]),
        goal('GOAL-D', SHA_B, 'closed', []),
        goal('GOAL-X', 'c'.repeat(64), 'closed', [{ ...deferTo('GOAL-Y'), id: 'R-22' }]),
        goal('GOAL-Y', SHA_A, 'closed', []),
      ];
      const orphans = orphanRequirements(reverse ? goals.reverse() : goals);
      expect(orphans).toHaveLength(2);
      expect(orphans).toContainEqual(
        expect.objectContaining({
          id: 'R-22',
          text: 'new brief text',
          sourceSha256: SHA_B,
          fromGoalId: 'GOAL-C',
          targetGoalId: 'GOAL-D',
        }),
      );
      expect(orphans).toContainEqual(
        expect.objectContaining({
          id: 'R-22',
          sourceSha256: 'c'.repeat(64),
          fromGoalId: 'GOAL-X',
          targetGoalId: 'GOAL-Y',
        }),
      );
    },
  );

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
