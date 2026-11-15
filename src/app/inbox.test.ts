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
