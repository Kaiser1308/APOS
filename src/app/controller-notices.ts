import { newEvent } from './events.js';
import type { GoalState } from '../domain/transitions.js';
import type { OrcaMessage } from '../ports/runtime.js';
import type { GoalRepository } from '../ports/goal-repository.js';

/** Minutes a handoff may stay pending before the Human is told. */
export const HANDOFF_PENDING_MINUTES = 10;
export const IDLE_MINUTES = 15;
export type ControllerTick = {
  goalId: string;
  dispatched: string[];
  recovered: string[];
  unresolved: string[];
  resumed: string[];
  settled: string[];
  inboxPending: string[];
  errors: string[];
  supervised: string[];
};

/**
 * While a handoff is pending the controller leaves the stopped dispatch alone, so a handoff whose CLI died would hold
 * the Goal silently. After HANDOFF_PENDING_MINUTES the Human is told once how to finish or drop it.
 */
export function noticePendingHandoff(
  store: GoalRepository,
  now: () => number,
  state: GoalState,
  result: ControllerTick,
): void {
  const pending = state.handoffIntent;
  const at = now();
  if (!pending || at - Date.parse(pending.at) < HANDOFF_PENDING_MINUTES * 60_000) return;
  const goalId = state.spec.id;
  if (
    store
      .events(goalId)
      .some(item => item.type === 'human-notified' && (item.data as { key?: string }).key === pending.key)
  )
    return;
  store.append(
    newEvent(
      goalId,
      'human-notified',
      {
        kind: 'needs-decision',
        goalId,
        key: pending.key,
        note: `the handoff of ${goalId} (from ${pending.from}) has been pending for ${HANDOFF_PENDING_MINUTES}+ min. Run \`apos handoff ${goalId}${pending.target.kind === 'package' ? ` --package ${pending.target.packageId}` : pending.target.kind === 'reviewer' ? ' --reviewer' : pending.target.kind === 'bot' ? ` --to-bot ${pending.target.botId}` : ''}\` to finish it (it recovers an agent that started), or check Orca and \`apos execution abandon-intent ${goalId} --key ${pending.key} --reason ...\` to drop it.`,
      },
      new Date(at).toISOString(),
    ),
  );
  result.supervised.push(`handoff ${pending.key} pending; Human notified`);
}

/** A question or escalation from the Lead before its plan is accepted: the Human is told once and the Lead is not answered for them. */
export function noticeLeadQuestion(
  store: GoalRepository,
  goalId: string,
  message: OrcaMessage,
  result: ControllerTick,
): void {
  if (
    store
      .events(goalId)
      .some(item => item.type === 'human-notified' && (item.data as { messageId?: string }).messageId === message.id)
  )
    return;
  const what = message.subject ?? message.body ?? message.type;
  store.append(
    newEvent(goalId, 'human-notified', {
      kind: 'lead-question',
      goalId,
      messageId: message.id,
      messageType: message.type,
      subject: message.subject,
      body: message.body,
      note: `the Lead is waiting on you: ${what}. Answer it with \`apos lead wake ${goalId} --note "..."\`.`,
    }),
  );
  result.supervised.push(`Lead ${message.type} ${message.id}; Human notified`);
}

/**
 * Seen live: a Goal sat 26 minutes with no agent running and nothing for the controller to do,
 * and no tick said so. A Solo Goal whose current dispatch has settled, with no reviewer pending and
 * no event for IDLE_MINUTES, is reported once per quiet spell.
 */
export function watchdog(store: GoalRepository, goalId: string, result: ControllerTick): void {
  const state = store.getGoal(goalId);
  if (!state || state.status !== 'executing' || !state.proposal) return;
  const ref = state.runtimeRef;
  // Multi-WP: no package still running and no reviewer pending (seen live: the Lead ended its turn waiting for a review nobody dispatched).
  const multiIdle =
    state.proposal.mode === 'multi-wp' &&
    !state.reviewDispatch &&
    !state.reviewIntent &&
    Object.values(state.packages ?? {}).every(
      item => item.status !== 'executing' || !item.runtimeRef || state.settlements?.[item.runtimeRef!.dispatchId],
    );
  const idle =
    state.proposal.mode === 'multi-wp'
      ? multiIdle
      : ref &&
        state.settlements?.[ref.dispatchId] &&
        !state.reviewDispatch &&
        !state.reviewIntent &&
        !state.resumeIntent;
  if (!idle) return;
  const events = store.events(goalId);
  const last = events.at(-1)!;
  if (last.type === 'human-notified' || Date.now() - Date.parse(last.at) < IDLE_MINUTES * 60_000) return;
  store.append(
    newEvent(goalId, 'human-notified', {
      kind: 'idle',
      goalId,
      since: last.at,
      lastEvent: last.type,
      note: `no agent running and no controller progress for ${IDLE_MINUTES}+ min after ${last.type}; tick errors: ${result.errors.join('; ') || 'none'}`,
    }),
  );
  result.supervised.push(`idle since ${last.at} after ${last.type}; Human notified`);
}

/** An error seen on one pass is logged; the same error on a later pass reaches the Human once, instead of repeating silently on every tick. */
export function noteErrors(store: GoalRepository, result: ControllerTick): void {
  // Ids, counters and durations differ on every pass; the same failure must still count as the same.
  const signature = (text: string) => text.replace(/[0-9a-f]{8,}|\d+/gi, '#');
  for (const error of new Map(result.errors.map(item => [signature(item), item])).values()) {
    const events = store.events(result.goalId);
    if (
      events.some(
        item =>
          item.type === 'human-notified' &&
          (item.data as { kind?: string; error?: string }).kind === 'tick-error' &&
          signature((item.data as { error?: string }).error ?? '') === signature(error),
      )
    )
      continue;
    if (
      !events.some(
        item =>
          item.type === 'decision-logged' &&
          signature((item.data as { tickError?: string })?.tickError ?? '') === signature(error),
      )
    ) {
      store.append(newEvent(result.goalId, 'decision-logged', { note: `tick error: ${error}`, tickError: error }));
      continue;
    }
    store.append(
      newEvent(result.goalId, 'human-notified', {
        kind: 'tick-error',
        goalId: result.goalId,
        error,
        note: `the controller fails the same way on every pass: ${error}. If it names an ended session, \`apos handoff ${result.goalId}\` starts a fresh agent.`,
      }),
    );
  }
}

/** True once the Lead answered this Orca message (`apos package answer`, or the Human's `lead wake` reply). */
export const answered = (store: GoalRepository, goalId: string, messageId: string): boolean =>
  store
    .events(goalId)
    .some(item => item.type === 'decision-logged' && (item.data as { answers?: string } | null)?.answers === messageId);

/** A Worker's question as the Lead reads it: who asked, what, and the command that answers it through the controller. */
export function describeQuestion(state: GoalState, message: OrcaMessage): string {
  const goalId = state.spec.id;
  const dispatchId = message.dispatchId ?? message.dispatch_id;
  const asker = Object.values(state.packages ?? {}).find(
    item =>
      item.runtimeRef &&
      ((message.from && item.runtimeRef.terminal === message.from) || item.runtimeRef.dispatchId === dispatchId),
  )?.spec.id;
  const text = [message.subject, message.body].filter(Boolean).join(': ');
  return `${message.type} ${message.id} from ${asker ? `the Worker of ${asker}` : (message.from ?? 'an agent')}${text ? ` (${text})` : ''}; answer it with apos package answer ${goalId} ${asker ?? '<packageId>'} --message-id ${message.id} --text-file <file> --reason <why>`;
}
