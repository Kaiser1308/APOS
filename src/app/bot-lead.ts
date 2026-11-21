import { newEvent } from './events.js';
import { writeLeadLog } from './lead-log.js';
import {
  WAKE_ACK_MINUTES,
  checkWakeDestination,
  noticeUnacked,
  overdueWakes,
  pendingEvents,
} from './bot-wake-check.js';
import { worktreePath } from '../runtime/orca/parse.js';
import { UserError } from '../domain/errors.js';
import type { GoalState } from '../domain/transitions.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { BotWakeInput, RuntimeAdapter } from '../ports/runtime.js';

/** The notice that tells a bot it holds the Lead; derived from the state, so a mail that failed is sent again. */
export const transferNotice = (state: GoalState): string | undefined =>
  state.leadBot
    ? `the Lead role of ${state.spec.id} moved to you (bot ${state.leadBot.name}) by ${state.leadBot.by} at ${state.leadBot.at}`
    : undefined;

const phase = (state: GoalState): BotWakeInput['mode'] =>
  !state.proposal || ['selected', 'planned'].includes(state.status) || state.proposalApprovedVersion === undefined
    ? 'plan'
    : state.proposal.mode === 'multi-wp'
      ? 'multi'
      : 'solo';

/** What a bot Lead is told outside the Multi-WP supervisor's batches: its transfer, a block, its Solo owner's delivery. */
export function botNotices(state: GoalState): string[] {
  const events = [transferNotice(state)].filter((item): item is string => Boolean(item));
  if (state.status === 'blocked') events.push(`${state.spec.id} is blocked: ${state.blocker?.note ?? 'unknown'}`);
  if (phase(state) !== 'solo') return events;
  // Findings, not the gate: a red gate is cleared by the resume the same tick starts.
  for (const finding of state.findings ?? [])
    events.push(`Solo owner finding (attempt ${finding.attempt ?? '?'}, ${finding.kind}): ${finding.note}`);
  if (state.gate?.result === 'green') events.push(`Solo owner gate green on ${state.gate.deliveryCommit}`);
  if (state.status === 'verified')
    events.push(`${state.spec.id} is verified on ${state.gate?.deliveryCommit}; the Human decides its outcome`);
  return events;
}

/**
 * Mails the bot holding the Lead the events it has not been sent yet, through Orca instead of a Lead terminal. A bot
 * has no dispatch to settle, so there is no "busy" hold: each new batch is one mail, recorded as `lead-woken`.
 */
export async function wakeBot(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  goalId: string,
  repoPath: string,
  events: string[],
  now: () => number = Date.now,
): Promise<string[]> {
  const state = store.getGoal(goalId);
  const bot = state?.leadBot;
  if (!state || !bot) return [];
  const fresh = [...new Set(events)].filter(item => !(state.wokenFor ?? []).includes(item));
  if (!fresh.length) return [];
  if (!runtime.wakeBot) {
    const asked = store
      .events(goalId)
      .some(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'lead-unreachable');
    if (!asked) store.append(newEvent(goalId, 'human-notified', { kind: 'lead-unreachable', goalId, events: fresh }));
    return [`Lead bot unreachable for: ${fresh.join('; ')}`];
  }
  return sendWake(store, runtime, state, repoPath, fresh, now);
}

/** One wake mail, its `lead-woken` with the mailbox Orca stored it in, and check D on that mailbox. */
async function sendWake(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  state: GoalState,
  repoPath: string,
  events: string[],
  now: () => number,
  resendOf?: string,
): Promise<string[]> {
  const goalId = state.spec.id;
  const bot = state.leadBot!;
  const mode = phase(state);
  if (mode === 'multi') writeLeadLog(store, goalId, state.lead?.ref.worktreeId);
  const sent = await runtime.wakeBot!({
    repoPath,
    goalId,
    bot: { id: bot.id, name: bot.name },
    events,
    mode,
    leadWorktree: worktreePath(state.lead?.ref.worktreeId),
  });
  store.append(
    newEvent(
      goalId,
      'lead-woken',
      {
        events,
        bot: bot.id,
        ...(sent.messageId ? { messageId: sent.messageId } : {}),
        ...(sent.toHandle ? { toHandle: sent.toHandle } : {}),
        ...(resendOf ? { resendOf } : {}),
      },
      new Date(now()).toISOString(),
    ),
  );
  const misrouted = checkWakeDestination(store, goalId, bot, sent, now);
  return [
    `${resendOf ? 'resent' : 'woke'} bot ${bot.name}: ${events.join('; ')}`,
    ...(misrouted ? [`Human notified: ${misrouted}`] : []),
  ];
}

/**
 * Check A: wakes the bot has run no Lead command after for ten minutes. The Human is told once, then the wakes are
 * resent once, in that order, so a crash in between never resends twice. A resend usually lands where the first one
 * did (Orca routes by the Run's coordinator), so the notice is what matters.
 */
async function chaseUnacked(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  state: GoalState,
  repoPath: string,
  now: () => number,
): Promise<string[]> {
  const bot = state.leadBot!;
  const pending = overdueWakes(store, state.spec.id, bot.id, now);
  if (!pending.length) return [];
  const note = noticeUnacked(store, state.spec.id, bot, pending, now);
  if (!runtime.wakeBot) return [`Human notified: ${note}`];
  const first = pending[0]!.data as { messageId?: string };
  const resent = await sendWake(
    store,
    runtime,
    store.getGoal(state.spec.id)!,
    repoPath,
    [
      `resent: APOS saw no Lead command from you within ${WAKE_ACK_MINUTES} minutes of wake ${first.messageId ?? pending[0]!.id}; run the ack first`,
      ...pendingEvents(pending),
    ],
    now,
    first.messageId ?? pending[0]!.id,
  );
  return [`Human notified: ${note}`, ...resent];
}

/**
 * A bot Lead never writes code, so a Multi-WP integration commit is the head of a verified package: the last one of a
 * sequential chain, or an integration package a Worker delivered. Any other commit is refused while a bot holds it.
 */
export function assertBotIntegrationCommit(state: GoalState, commit: string): void {
  if (!state.leadBot || state.proposal?.mode !== 'multi-wp') return;
  const heads = Object.values(state.packages ?? {})
    .filter(item => item.status === 'verified')
    .map(item => (item.gate?.deliveryCommit ?? item.evidence.at(-1)?.commitRef)?.toLowerCase())
    .filter(Boolean);
  if (!heads.includes(commit.toLowerCase()))
    throw new UserError(
      `${commit} is not the head of a verified package of ${state.spec.id}, and its Lead (bot ${state.leadBot.name}) never writes code: integrate on the last package's head, or add an integration package for a Worker`,
    );
}

/** After a controller tick: every bot holding a Lead gets what it has not been told yet. */
export async function wakeBotLeads(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  repoPath: string,
  results: { goalId: string; supervised: string[]; errors: string[] }[],
  now: () => number = Date.now,
): Promise<void> {
  for (const state of store.listGoals()) {
    if (!state.leadBot || ['closed', 'stopped', 'draft'].includes(state.status)) continue;
    const result = results.find(item => item.goalId === state.spec.id);
    try {
      result?.supervised.push(...(await chaseUnacked(store, runtime, state, repoPath, now)));
      const current = store.getGoal(state.spec.id)!;
      const actions = await wakeBot(store, runtime, state.spec.id, repoPath, botNotices(current), now);
      result?.supervised.push(...actions);
    } catch (error) {
      result?.errors.push(`bot lead: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
