import { newEvent } from './events.js';
import { writeLeadLog } from './lead-log.js';
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
  const mode = phase(state);
  if (mode === 'multi') writeLeadLog(store, goalId, state.lead?.ref.worktreeId);
  const sent = await runtime.wakeBot({
    repoPath,
    goalId,
    bot: { id: bot.id, name: bot.name },
    events: fresh,
    mode,
    leadWorktree: worktreePath(state.lead?.ref.worktreeId),
  });
  store.append(
    newEvent(goalId, 'lead-woken', {
      events: fresh,
      bot: bot.id,
      ...(sent.messageId ? { messageId: sent.messageId } : {}),
    }),
  );
  return [`woke bot ${bot.name}: ${fresh.join('; ')}`];
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
): Promise<void> {
  for (const state of store.listGoals()) {
    if (!state.leadBot || ['closed', 'stopped', 'draft'].includes(state.status)) continue;
    const result = results.find(item => item.goalId === state.spec.id);
    try {
      const actions = await wakeBot(store, runtime, state.spec.id, repoPath, botNotices(state));
      result?.supervised.push(...actions);
    } catch (error) {
      result?.errors.push(`bot lead: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
