import { z } from 'zod';
import type { BotIdentity, BotWakeInput } from '../../ports/runtime.js';
import { botLeadBrief } from '../bot-brief.js';
import { OrcaRefused } from './exec.js';
import { object } from './parse.js';

const botList = z.object({
  bots: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), paused: z.boolean().optional() })),
});
const botChats = z.object({ bot: z.string().min(1) });

/** `orca bot list --json`: every bot on this computer, by id and name. */
export function parseBotList(value: unknown): BotIdentity[] {
  return botList.parse(value).bots.map(item => ({ id: item.id, name: item.name, paused: item.paused ?? false }));
}

/** `orca bot chats --json` run from a bot's chat names that bot (seen live on Orca 1.4.265). */
export function parseBotChats(value: unknown): string {
  return botChats.parse(value).bot;
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
  if (!bot) throw new Error(`Orca names this session's bot ${name}, but \`orca bot list\` has no such bot`);
  return bot;
}

/** Mails the bot by id (names hold spaces and can change): a `handoff` is a job it takes, a `status` only informs. */
export function mailBot(
  execute: (args: string[]) => Record<string, unknown>,
  bot: BotIdentity,
  type: 'handoff' | 'status',
  subject: string,
  body: string,
): { messageId?: string } {
  const sent = execute([
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
  ]);
  const id = object(sent.message).id ?? sent.id ?? sent.messageId;
  return typeof id === 'string' ? { messageId: id } : {};
}

export function wakeBot(
  execute: (args: string[]) => Record<string, unknown>,
  input: BotWakeInput,
): { messageId?: string } {
  return mailBot(
    execute,
    input.bot,
    'handoff',
    `APOS ${input.goalId}: Lead work (${input.events.length} event${input.events.length === 1 ? '' : 's'})`,
    botLeadBrief(input),
  );
}
