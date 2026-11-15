import { describe, expect, it } from 'vitest';
import { newEvent } from './events.js';

describe('newEvent', () => {
  it('builds an event with a fresh id and the given time', () => {
    const e = newEvent('GOAL-1', 'decision-logged', { note: 'x' }, '2026-11-14T00:00:00.000Z');
    expect(e).toMatchObject({
      goalId: 'GOAL-1',
      type: 'decision-logged',
      data: { note: 'x' },
      at: '2026-11-14T00:00:00.000Z',
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('omits data when none is given', () => {
    expect('data' in newEvent('GOAL-1', 'goal-selected')).toBe(false);
  });
});
