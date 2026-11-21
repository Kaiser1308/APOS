import { z } from 'zod';
import type { BotIdentity, BotWakeInput } from '../../ports/runtime.js';
import { botLeadBrief } from '../bot-brief.js';
import { UserError } from '../../domain/errors.js';
import { OrcaRefused } from './exec.js';

const botList = z.object({
  bots: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), paused: z.boolean().optional() })),
});
const botChats = z.object({ bot: z.string().min(1) });
const runCurrent = z.object({ runId: z.string().min(1).nullable().optional() });
const sendReceipt = z.object({
  message: z.object({ id: z.string().min(1).optional(), to_handle: z.string().min(1).optional() }).optional(),
  id: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
});

/** `orca bot list --json`: every bot on this computer, by id and name. */
export function parseBotList(value: unknown): BotIdentity[] {
  return botList.parse(value).bots.map(item => ({ id: item.id, name: item.name, paused: item.paused ?? false }));
}

/** `orca bot chats --json` run from a bot's chat names that bot (seen live on Orca 1.4.265). */
export function parseBotChats(value: unknown): string {
  return botChats.parse(value).bot;
}

/** `orca orchestration run-current --json`: the Run this session coordinates, or undefined when it has none. */
export function parseRunCurrent(value: unknown): string | undefined {
  return runCurrent.parse(value).runId ?? undefined;
}

/**
 * The receipt of `orca orchestration send --json --full`. Only the full view names `to_handle`, the mailbox Orca
 * stored the mail in (seen live on Orca 1.4.265: a mail to a session that coordinates a Run is stored as `run:<id>`).
 */
export function parseSendReceipt(value: unknown): { messageId?: string; toHandle?: string } {
  const receipt = sendReceipt.parse(value);
  const messageId = receipt.message?.id ?? receipt.id ?? receipt.messageId;
  const toHandle = receipt.message?.to_handle;
  return { ...(messageId ? { messageId } : {}), ...(toHandle ? { toHandle } : {}) };
}

/** A bot by its id, or by its name ignoring case; undefined when this computer has none. */
export function findBot(
  execute: (args: string[]) => Record<string, unknown>,
  nameOrId: string,
): BotIdentity | undefined {
  const bots = parseBotList(execute(['bot', 'list']));
  const wanted = nameOrId.trim().toLowerCase();
  return bots.find(item => item.id === nameOrId.trim()) ?? bots.find(item => item.name.toLowerCase() === wanted);
}

/**
 * The bot whose chat runs this process. Orca injects ORCA_AGENT_SESSION_ID into a bot chat, and that id is the chat's
 * id; `orca bot chats` resolves it to the bot. Orca answers `invalid_argument` outside a bot chat: not a bot. Any other
 * failure throws, so a caller that must refuse bots fails closed. Orca trusts the env var it is given, so this is a
 * guardrail at the same level as ORCA_TERMINAL_HANDLE, not a security boundary.
 */
export function callerBot(
  execute: (args: string[]) => Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): BotIdentity | undefined {
  if (!env.ORCA_AGENT_SESSION_ID?.trim()) return undefined;
  let name: string;
  try {
    name = parseBotChats(execute(['bot', 'chats']));
  } catch (error) {
    if (error instanceof OrcaRefused && error.code === 'invalid_argument') return undefined;
    throw error;
  }
  const bot = findBot(execute, name);
  // Orca's two answers disagree (a bot renamed or removed between the calls): the Human checks Orca, then retries.
  if (!bot)
    throw new UserError(
      `Orca names this session's bot ${name}, but \`orca bot list\` has no such bot; check \`orca bot list\` and retry`,
    );
  return bot;
}

/**
 * The mailbox Orca stores mail for this chat in: the Run it coordinates (`run:<id>`), else its own session. Mail to the
 * bot that Orca stores under any other handle reaches another chat (seen live on 21/11: a chat that had lost its Run to
 * another chat's `run-use` had its mail delivered to that chat). Undefined outside an Orca agent session.
 */
export function callerMailbox(
  execute: (args: string[]) => Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const session = env.ORCA_AGENT_SESSION_ID?.trim();
  if (!session) return undefined;
  const runId = parseRunCurrent(execute(['orchestration', 'run-current']));
  return runId ? `run:${runId}` : `orca_session_id:${session}`;
}

/** Mails the bot by id (names hold spaces and can change): a `handoff` is a job it takes, a `status` only informs. */
export function mailBot(
  execute: (args: string[]) => Record<string, unknown>,
  bot: BotIdentity,
  type: 'handoff' | 'status',
  subject: string,
  body: string,
): { messageId?: string; toHandle?: string } {
  return parseSendReceipt(
    execute([
      'orchestration',
      'send',
      '--to',
      `bot:${bot.id}`,
      '--type',
      type,
      '--subject',
      subject,
      '--body',
      body,
      '--full',
    ]),
  );
}

export function wakeBot(
  execute: (args: string[]) => Record<string, unknown>,
  input: BotWakeInput,
): { messageId?: string; toHandle?: string } {
  return mailBot(
    execute,
    input.bot,
    'handoff',
    `APOS ${input.goalId}: Lead work (${input.events.length} event${input.events.length === 1 ? '' : 's'})`,
    botLeadBrief(input),
  );
}
