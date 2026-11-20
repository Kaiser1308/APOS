import { newEvent } from './events.js';
import { clockStart } from './lead.js';
import type { GoalRepository } from '../ports/goal-repository.js';

export function multiWallTimeExpired(store: GoalRepository, goalId: string, now: () => number = Date.now): boolean {
  const state = store.getGoal(goalId);
  const start = clockStart(store.events(goalId));
  if (
    state?.proposal?.mode !== 'multi-wp' ||
    !state.appetite ||
    !start ||
    (now() - Date.parse(start)) / 60_000 <= state.appetite.maxWallMinutes
  )
    return false;
  const limit = state.appetite.maxWallMinutes;
  let noticeEvent = [...store.events(goalId)]
    .reverse()
    .find(event => event.type === 'multi-time-exhausted' && (event.data as { limit?: number }).limit === limit);
  if (state.multiTimeExhaustedLimit !== limit || !noticeEvent) {
    const reason = `Multi-WP wall time ${limit} minutes exhausted; Human may adjust appetite`;
    noticeEvent = newEvent(goalId, 'multi-time-exhausted', { limit, reason });
    store.append(noticeEvent);
  }
  if (
    !store
      .events(goalId)
      .some(
        event =>
          event.type === 'human-notified' && (event.data as { timeEvent?: string }).timeEvent === noticeEvent!.id,
      )
  )
    store.append(
      newEvent(goalId, 'human-notified', {
        kind: 'needs-decision',
        goalId,
        timeEvent: noticeEvent.id,
        note: (noticeEvent.data as { reason: string }).reason,
      }),
    );
  return true;
}
