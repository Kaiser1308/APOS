import { randomUUID } from 'node:crypto';
import type { GoalEvent, GoalEventType } from '../domain/transitions.js';

export function newEvent(
  goalId: string,
  type: GoalEventType,
  data?: unknown,
  at: string = new Date().toISOString(),
): GoalEvent {
  const event: GoalEvent = { id: randomUUID(), goalId, type, at };
  if (data !== undefined) event.data = data;
  return event;
}
