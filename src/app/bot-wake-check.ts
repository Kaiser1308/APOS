import { newEvent } from './events.js';
import { WAKE_ACK_MINUTES } from '../runtime/bot-brief.js';
import type { GoalEvent } from '../domain/transitions.js';
import type { GoalRepository } from '../ports/goal-repository.js';

/**
 * Orca can deliver a mail for a bot to another chat of that bot without saying so (seen live on 21/11: three wakes
 * went to a chat that had taken the Home chat's Run with `run-use`, and that chat ended each turn with NO_REPLY). Two
 * checks, both read from the event log, tell the Human instead of letting the Goal stall: the mailbox a wake landed in
 * against the one the bot's Lead chat named (`lead-bot-checked-in`), and a Lead command within ten minutes of a wake.
 */
export { WAKE_ACK_MINUTES };

type Woken = { bot?: string; messageId?: string; toHandle?: string; resendOf?: string; events?: string[] };
type CheckIn = { botId?: string; mailbox?: string; acked?: string[] };
type Notice = { kind?: string; botId?: string; wake?: string; toHandle?: string; expected?: string };

/** The events since the current bot took the Lead: what an older holder did or was sent does not count. */
function sinceTransfer(store: GoalRepository, goalId: string): GoalEvent[] {
  const events = store.events(goalId);
  const start = events.map(item => item.type).lastIndexOf('lead-transferred');
  return events.slice(start + 1);
}

const checkIns = (events: GoalEvent[], botId: string) =>
  events.filter(item => item.type === 'lead-bot-checked-in' && (item.data as CheckIn).botId === botId);

/** Index of the bot's latest check-in in `events`, or -1. */
const lastCheckIn = (events: GoalEvent[], botId: string) =>
  events.map(item => item.type === 'lead-bot-checked-in' && (item.data as CheckIn).botId === botId).lastIndexOf(true);

const notices = (events: GoalEvent[], kind: string, botId: string) =>
  events.filter(
    item =>
      item.type === 'human-notified' && (item.data as Notice).kind === kind && (item.data as Notice).botId === botId,
  );

/** The mailbox the bot's Lead chat named at its latest check-in, if it named one. */
export function botMailbox(store: GoalRepository, goalId: string, botId: string): string | undefined {
  return checkIns(sinceTransfer(store, goalId), botId)
    .map(item => (item.data as CheckIn).mailbox)
    .filter(Boolean)
    .at(-1);
}

/** Wakes mailed to the bot after its latest check-in: none of them has been acted on yet. */
export function unackedWakes(store: GoalRepository, goalId: string, botId: string): GoalEvent[] {
  const events = sinceTransfer(store, goalId);
  return events
    .slice(lastCheckIn(events, botId) + 1)
    .filter(item => item.type === 'lead-woken' && (item.data as Woken).bot === botId);
}

const wakeId = (event: GoalEvent) => (event.data as Woken).messageId ?? event.id;

/**
 * Records that the bot holding the Lead ran a Lead command from its chat: it acks every wake before it and names the
 * mailbox of that chat. Nothing is written when there is no wake to ack and the mailbox is unchanged.
 */
export function recordBotCheckIn(
  store: GoalRepository,
  goalId: string,
  botId: string,
  mailbox: string | undefined,
  command: string,
  now: () => number = Date.now,
): { acked: string[]; mailbox?: string } {
  const acked = unackedWakes(store, goalId, botId).map(wakeId);
  const known = botMailbox(store, goalId, botId);
  if (!acked.length && (!mailbox || mailbox === known)) return { acked, mailbox: known };
  store.append(
    newEvent(
      goalId,
      'lead-bot-checked-in',
      { botId, command, acked, ...(mailbox ? { mailbox } : {}) },
      new Date(now()).toISOString(),
    ),
  );
  return { acked, mailbox: mailbox ?? known };
}

/**
 * Check D, right after a wake is sent: Orca's receipt names the mailbox it stored the mail in, and it must be the one
 * the bot's Lead chat named. A mismatch means another chat of the bot got the wake; the Human hears it at once, once
 * per wrong mailbox until the bot checks in again. A receipt without a mailbox is reported once: the check is blind.
 */
export function checkWakeDestination(
  store: GoalRepository,
  goalId: string,
  bot: { id: string; name: string },
  sent: { messageId?: string; toHandle?: string },
  now: () => number = Date.now,
): string | undefined {
  const expected = botMailbox(store, goalId, bot.id);
  if (!expected || sent.toHandle === expected) return undefined;
  const events = sinceTransfer(store, goalId);
  const latest = lastCheckIn(events, bot.id);
  const kind = sent.toHandle ? 'lead-wake-misrouted' : 'lead-wake-unchecked';
  const seen = notices(events.slice(latest + 1), kind, bot.id).some(
    item => (item.data as Notice).toHandle === sent.toHandle && (item.data as Notice).expected === expected,
  );
  if (seen) return undefined;
  const id = sent.messageId ?? 'without an id';
  const note = sent.toHandle
    ? `APOS's wake mail ${id} went to the wrong chat of bot ${bot.name}: Orca stored it in ${sent.toHandle}, but the bot's Lead chat reads ${expected}. Open the bot in Orca, find the chat that coordinates ${sent.toHandle.replace(/^run:/, 'Run ')}, and have the Lead chat act on ${goalId}.`
    : `Orca's receipt for APOS's wake mail ${id} to bot ${bot.name} names no mailbox, so APOS cannot check that it reached the Lead chat (${expected}); check that chat in Orca.`;
  store.append(
    newEvent(
      goalId,
      'human-notified',
      {
        kind,
        goalId,
        botId: bot.id,
        bot: bot.name,
        messageId: sent.messageId,
        ...(sent.toHandle ? { toHandle: sent.toHandle } : {}),
        expected,
        note,
      },
      new Date(now()).toISOString(),
    ),
  );
  return note;
}

/**
 * Check A: the oldest wake the bot has not acted on, once it is ten minutes old and the Human has not been told about
 * it yet. The caller records the notice, then resends once; the notice is the guard, so a crash between the two can
 * never resend twice. Returns the wakes to resend, oldest first.
 */
export function overdueWakes(
  store: GoalRepository,
  goalId: string,
  botId: string,
  now: () => number = Date.now,
): GoalEvent[] {
  const pending = unackedWakes(store, goalId, botId);
  const first = pending[0];
  if (!first || now() - Date.parse(first.at) < WAKE_ACK_MINUTES * 60_000) return [];
  const told = notices(sinceTransfer(store, goalId), 'lead-wake-unacked', botId).some(
    item => (item.data as Notice).wake === first.id,
  );
  return told ? [] : pending;
}

/** The notice for wakes no Lead command followed; recorded before the one resend. */
export function noticeUnacked(
  store: GoalRepository,
  goalId: string,
  bot: { id: string; name: string },
  pending: GoalEvent[],
  now: () => number = Date.now,
): string {
  const ids = pending.map(wakeId);
  const where = [...new Set(pending.map(item => (item.data as Woken).toHandle).filter(Boolean))];
  const note = `bot ${bot.name} ran no APOS Lead command for ${goalId} within ${WAKE_ACK_MINUTES} minutes of wake ${ids.join(', ')}${where.length ? ` (Orca stored it in ${where.join(', ')})` : ''}. APOS resends it once; check in Orca which chat of the bot got it and whether that chat ended its turn without acting.`;
  store.append(
    newEvent(
      goalId,
      'human-notified',
      { kind: 'lead-wake-unacked', goalId, botId: bot.id, bot: bot.name, wake: pending[0]!.id, messageIds: ids, note },
      new Date(now()).toISOString(),
    ),
  );
  return note;
}

/** What the resend carries: the events of every unacked wake, once each. */
export const pendingEvents = (pending: GoalEvent[]): string[] => [
  ...new Set(pending.flatMap(item => (item.data as Woken).events ?? [])),
];
