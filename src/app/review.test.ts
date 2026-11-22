import { expect, it } from 'vitest';
import { ReviewService } from './review.js';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, approval } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';

it('records a review as advice: it does not gate verification and its shape is still checked', () => {
  const store = SqliteStore.open(':memory:');
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  add('proposal-drafted', { ...proposal, risks: ['Auth regression'] });
  add('proposal-approved');
  const reviews = new ReviewService(store);
  expect(() => reviews.submit(spec.id, { subject: 'goal', reviewer: 'r', result: 'pass', note: 'x' })).toThrow();
  reviews.submit(spec.id, {
    subject: 'goal',
    reviewer: 'reviewer-agent',
    session: 'review-1',
    result: 'changes',
    commitRef: 'a'.repeat(40),
    note: 'Consider the auth path',
  });
  expect(store.getGoal(spec.id)?.reviews).toHaveLength(1);
  expect(store.getGoal(spec.id)?.status).toBe('executing');
  store.close();
});
