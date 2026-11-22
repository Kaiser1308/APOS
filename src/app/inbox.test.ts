import { expect, it } from 'vitest';
import { buildInbox } from './inbox.js';
import type { GoalRepository } from '../ports/goal-repository.js';

const repoOf = (status: string, kinds: string[]) =>
  ({
    listGoals: () => [{ spec: { id: 'GOAL-1' }, status }],
    events: () =>
      kinds.map((kind, index) => ({
        id: `E${index}`,
        goalId: 'GOAL-1',
        type: 'human-notified',
        data: { kind, goalId: 'GOAL-1' },
        at: '2026-11-14T00:00:00.000Z',
      })),
  }) as unknown as GoalRepository;

it('keeps no awaiting-outcome notice once the Goal is closed or stopped (GitHub #8)', () => {
  for (const status of ['closed', 'stopped'])
    expect(buildInbox(repoOf(status, ['awaiting-outcome', 'overrun']))).toEqual([]);
});

it('still shows a notice for a Goal that is running', () => {
  expect(buildInbox(repoOf('executing', ['overrun']))).toEqual([
    expect.objectContaining({ goalId: 'GOAL-1', kind: 'notice' }),
  ]);
});

it('drops a lead-question notice once the Human has answered it', () => {
  const at = '2026-11-14T00:00:00.000Z';
  const repo = {
    listGoals: () => [{ spec: { id: 'GOAL-1' }, status: 'selected' }],
    events: () => [
      { id: 'E1', goalId: 'GOAL-1', type: 'human-notified', data: { kind: 'lead-question', messageId: 'm1' }, at },
      { id: 'E2', goalId: 'GOAL-1', type: 'human-notified', data: { kind: 'lead-question', messageId: 'm2' }, at },
      { id: 'E3', goalId: 'GOAL-1', type: 'decision-logged', data: { answers: 'm1' }, at },
    ],
  } as unknown as GoalRepository;
  expect(buildInbox(repo).map(item => JSON.parse(item.detail).messageId)).toEqual(['m2']);
});

it('shows the warnings a gate report carries as one attention notice, and nothing for an archived Goal', () => {
  const gate = { warnings: ['needs attention: tests or oracles changed: a.test.ts (not locked before phase 3)'] };
  const repo = (status: string) =>
    ({
      listGoals: () => [{ spec: { id: 'GOAL-1' }, status, gate, packages: {} }],
      events: () => [],
    }) as unknown as GoalRepository;
  const [item] = buildInbox(repo('executing'));
  expect(item).toMatchObject({ goalId: 'GOAL-1', kind: 'notice' });
  expect(JSON.parse(item.detail)).toEqual({ kind: 'attention', warnings: gate.warnings });
  expect(buildInbox(repo('legacy'))).toEqual([]);
});

it('lists every needs-human package with why: the manual check waiting on a commit, or the unverifiable check', () => {
  const gate = (checks: unknown[]) => ({ at: '2026-11-14T00:00:00.000Z', deliveryCommit: 'a'.repeat(40), checks });
  const repo = (status: string) =>
    ({
      listGoals: () => [
        {
          spec: { id: 'GOAL-1' },
          status,
          packages: {
            'WP-A': {
              status: 'needs-human',
              gate: gate([{ checkId: 'CHK-M', status: 'manual-pending', reason: 'awaiting manual confirmation' }]),
            },
            'WP-B': {
              status: 'needs-human',
              gate: gate([
                { checkId: 'CHK-U', status: 'unverifiable', reason: 'delivery flaky: repeated runs disagree' },
              ]),
            },
            'WP-C': { status: 'green', gate: gate([]) },
          },
        },
      ],
      events: () => [],
    }) as unknown as GoalRepository;
  const items = buildInbox(repo('executing')).map(item => ({ kind: item.kind, ...JSON.parse(item.detail) }));
  expect(items).toEqual([
    {
      kind: 'needs-decision',
      packageId: 'WP-A',
      why: 'package-needs-human',
      reasons: [`manual check CHK-M awaits confirmation on ${'a'.repeat(40)} (apos gate confirm), then submit again`],
    },
    {
      kind: 'needs-decision',
      packageId: 'WP-B',
      why: 'package-needs-human',
      reasons: ['CHK-U unverifiable: delivery flaky: repeated runs disagree'],
    },
  ]);
  expect(buildInbox(repo('legacy'))).toEqual([]);
});

it('lists what waits for an exception: a sensitive file (with the command to approve it), and a revision of locked tests', () => {
  const commit = 'a'.repeat(40);
  const state = (exceptions: unknown[], pendingRevision?: unknown) => ({
    spec: { id: 'GOAL-1' },
    status: 'executing',
    exceptions,
    ...(pendingRevision ? { pendingRevision } : {}),
    packages: {
      'WP-A': {
        status: 'needs-human',
        gate: {
          at: '2026-11-14T00:00:00.000Z',
          deliveryCommit: commit,
          checks: [{ checkId: 'APOS-SCOPE', status: 'needs-human', reason: 'sensitive files changed: pyproject.toml' }],
        },
      },
    },
  });
  const repo = (exceptions: unknown[], pending?: unknown) =>
    ({ listGoals: () => [state(exceptions, pending)], events: () => [] }) as unknown as GoalRepository;
  const details = (exceptions: unknown[], pending?: unknown) =>
    buildInbox(repo(exceptions, pending)).map(item => JSON.parse(item.detail) as Record<string, unknown>);

  expect(details([])[0]?.reasons).toEqual([
    'APOS-SCOPE needs-human: sensitive files changed: pyproject.toml. Approve with: apos exception approve GOAL-1 --kind needs-human --ref WP-A --reason <why> (--by agent:<name> | --human)',
  ]);
  expect(details([{ kind: 'needs-human', ref: 'WP-A', commit }])[0]?.reasons).toEqual([
    `exception approved for WP-A on ${commit}: submit again with the same commit`,
  ]);
  const pending = { commit: 'b'.repeat(40), reason: 'drops a test', problems: ['x'], by: 't' };
  expect(details([], pending).map(item => item.why)).toEqual(['package-needs-human', 'tests-revision-pending']);
  expect(
    details([{ kind: 'tests-weakened', ref: pending.commit, commit: pending.commit }], pending).map(item => item.why),
  ).toEqual(['package-needs-human']);
});
