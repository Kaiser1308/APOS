import { z } from 'zod';
import { InvariantError } from './errors.js';
import type { GoalEvent, GoalState } from './transitions.js';

export const EXCEPTION_KINDS = ['needs-human', 'tests-weakened', 'floor-reduced'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
/** Spec 7.3: all three are things the Human lets an agent approve; each approval is logged with who. */
export const AGENT_MAY_APPROVE: readonly ExceptionKind[] = EXCEPTION_KINDS;

const schema = z.object({
  kind: z.enum(EXCEPTION_KINDS),
  /** A package id for `needs-human`, the revision commit for `tests-weakened`. */
  ref: z.string().min(1),
  commit: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
  reason: z.string().trim().min(1),
  /** `agent:<name>`, or `human` (then `confirmation` says how it was confirmed). */
  by: z.string().regex(/^(agent:\S+|human)$/, 'by is "agent:<name>" or "human"'),
  confirmation: z.object({ by: z.enum(['human', 'on-behalf']), onBehalf: z.string().min(1).optional() }).optional(),
});
export type ExceptionRecord = z.infer<typeof schema> & { at: string };

export function parseException(value: unknown): z.infer<typeof schema> {
  return schema.parse(value);
}

/** Whether `ref` at `commit` has an approved exception of that kind. */
export const hasException = (state: GoalState, kind: ExceptionKind, ref: string, commit: string): boolean =>
  (state.exceptions ?? []).some(
    item => item.kind === kind && item.ref === ref && item.commit.toLowerCase() === commit.toLowerCase(),
  );

export function applyException(state: GoalState, event: GoalEvent): GoalState {
  const data = parseException(event.data);
  if (data.by.startsWith('agent:') && !AGENT_MAY_APPROVE.includes(data.kind))
    throw new InvariantError(`An agent cannot approve ${data.kind}`);
  if (data.by === 'human' && !data.confirmation) throw new InvariantError('A Human exception needs its confirmation');
  return { ...state, exceptions: [...(state.exceptions ?? []), { ...data, at: event.at }] };
}
