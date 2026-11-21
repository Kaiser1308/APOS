import { InvariantError } from './errors.js';
import type { GoalEvent, GoalState } from './transitions.js';

/** The Orca bot holding a Goal's Lead role, recorded by `lead-transferred`; `by` and `at` say who moved it and when. */
export type LeadBot = { id: string; name: string; by: string; at: string };

/** The app builds these events only after checking the same rules, so a violation here is a defect. */
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new InvariantError(message);
}

/**
 * `lead-transferred` settles a pending handoff of kind `bot`: the APOS-dispatched Lead (`from`) is stopped and the
 * bot takes the Lead role. `lead-returned` gives the role back; the Human then starts a fresh APOS Lead with the
 * ordinary handoff (see `transferable` for when a transfer is allowed).
 */
export function applyLeadTransfer(state: GoalState, event: GoalEvent): GoalState {
  if (event.type === 'lead-transferred') {
    const data = event.data as {
      key?: string;
      from?: string;
      by?: string;
      bot?: { id?: string; name?: string };
    };
    const pending = state.handoffIntent;
    const by = data?.by?.trim();
    check(
      pending?.target.kind === 'bot' && data?.key === pending.key && data.from === pending.from,
      'Lead transfer must settle the pending transfer to a bot',
    );
    check(
      data.bot?.id && data.bot.name && data.bot.id === pending.target.botId && by,
      'Lead transfer needs the bot (id and name) and who transferred it',
    );
    check(transferable(state), 'Only a planning Lead or the Lead of a running Multi-WP Goal can move to a bot');
    return {
      ...state,
      handoffIntent: undefined,
      leadBot: { id: data.bot.id, name: data.bot.name, by, at: event.at },
    };
  }
  // lead-returned
  const data = event.data as { by?: string; botId?: string };
  check(state.leadBot, 'No bot holds the Lead of this Goal');
  check(data?.botId === state.leadBot.id && data.by?.trim(), 'Lead return needs the bot that holds it and who decided');
  check(!state.handoffIntent, 'A handoff is pending for this Goal');
  return { ...state, leadBot: undefined };
}

/**
 * When an APOS-dispatched Lead may move to a bot: while it plans (the bot then proposes and commits, and in Solo the
 * controller dispatches a separate owner because a bot Lead never writes code), or once a Multi-WP plan runs. A Solo
 * plan already being delivered is refused: its owner is that very Lead dispatch, in the middle of writing code.
 */
export const transferable = (state: GoalState): boolean =>
  Boolean(state.lead) &&
  (['selected', 'planned'].includes(state.status) ||
    (state.proposal?.mode === 'multi-wp' && ['executing', 'blocked'].includes(state.status)));
