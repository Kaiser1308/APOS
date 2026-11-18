import { describe, expect, it } from 'vitest';
import { filterInboxSince, itemCursorId, type HumanInboxItem } from './wait.js';

const item = (n: number): HumanInboxItem => ({
  goalId: `GOAL-${n}`,
  kind: 'notice',
  detail: `notice ${n}`,
  at: '2026-11-18T06:00:00.000Z',
});

describe('inbox --since cursor', () => {
  it('reports each item once and does not repeat it', () => {
    const first = filterInboxSince([item(1), item(2)]);
    expect(first.fresh).toHaveLength(2);
    const second = filterInboxSince([item(1), item(2), item(3)], first.cursor);
    expect(second.fresh.map(i => i.goalId)).toEqual(['GOAL-3']);
  });

  it('stays as small as the current inbox instead of remembering every item ever seen', () => {
    const big = Array.from({ length: 50 }, (_, n) => item(n));
    const cursor = filterInboxSince(big).cursor;
    const after = filterInboxSince([item(1)], cursor);
    expect(after.cursor).toBe(itemCursorId(item(1)));
    expect(after.fresh).toHaveLength(0);
    // An item that was resolved and comes back is reported again.
    expect(filterInboxSince(big, after.cursor).fresh).toHaveLength(49);
  });
});
