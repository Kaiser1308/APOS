import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botLeadBrief } from '../bot-brief.js';
import { callerBot, findBot, mailBot, wakeBot } from './bots.js';
import { OrcaRefused } from './exec.js';

// Shapes seen live on Orca 1.4.265: `orca bot list --json` and `orca bot chats --json` run from a bot's chat.
const list = {
  bots: [
    { id: '5b1c9e55', name: 'Drak', agent: 'claude', paused: false },
    { id: 'd443bcb7', name: 'Lead APOS', agent: 'claude', paused: false },
  ],
};
const chats = { bot: 'Lead APOS', chats: [{ id: 'b3aa3d2a', title: 'Home', home: true, self: true }] };

describe('Orca bots', () => {
  it('finds a bot by id or by name, ignoring case', () => {
    const execute = () => list;
    expect(findBot(execute, 'd443bcb7')).toEqual({ id: 'd443bcb7', name: 'Lead APOS', paused: false });
    expect(findBot(execute, 'lead apos')?.id).toBe('d443bcb7');
    expect(findBot(execute, 'Forge')).toBeUndefined();
  });

  it('names the calling bot from its chat session, and nothing outside a bot chat', () => {
    const calls: string[][] = [];
    const execute = (args: string[]) => {
      calls.push(args);
      return args[1] === 'chats' ? chats : list;
    };
    expect(callerBot(execute, {})).toBeUndefined();
    expect(calls).toEqual([]);
    expect(callerBot(execute, { ORCA_AGENT_SESSION_ID: 'b3aa3d2a' })).toMatchObject({ id: 'd443bcb7' });
    const notBot = () => {
      throw new OrcaRefused('Name the bot with --bot, or run this from the bot’s chat.', 'invalid_argument');
    };
    expect(callerBot(notBot, { ORCA_AGENT_SESSION_ID: 'x' })).toBeUndefined();
  });

  it('throws when Orca cannot tell, so a Human command fails closed', () => {
    const down = () => {
      throw new Error('Orca bot chats failed: connect ECONNREFUSED');
    };
    expect(() => callerBot(down, { ORCA_AGENT_SESSION_ID: 'x' })).toThrow(/ECONNREFUSED/);
    expect(() =>
      callerBot((args: string[]) => (args[1] === 'chats' ? { bot: 'Ghost' } : list), { ORCA_AGENT_SESSION_ID: 'x' }),
    ).toThrow(/no such bot/);
  });

  it('mails a bot by id: a handoff job for a wake, a status for information', () => {
    const calls: string[][] = [];
    const execute = (args: string[]) => {
      calls.push(args);
      return { message: { id: 'msg_1' } };
    };
    const bot = { id: 'd443bcb7', name: 'Lead APOS' };
    expect(
      wakeBot(execute, { repoPath: 'C:/repo', goalId: 'GOAL-001', bot, events: ['a', 'b'], mode: 'multi' }),
    ).toEqual({ messageId: 'msg_1' });
    expect(calls[0].slice(0, 6)).toEqual(['orchestration', 'send', '--to', 'bot:d443bcb7', '--type', 'handoff']);
    const body = calls[0][calls[0].indexOf('--body') + 1];
    expect(body).toMatch(/never write, commit or merge code/);
    expect(body).toMatch(/integration gate GOAL-001 --commit <that head> --reason/);
    expect(body).toMatch(/\(1\) a\n\(2\) b/);
    mailBot(execute, bot, 'status', 'ended', 'stop');
    expect(calls[1].slice(4, 6)).toEqual(['--type', 'status']);
  });

  it('names only Lead files that exist, the controller home, and no worker_done (seen live in a bot chat)', () => {
    const tree = mkdtempSync(join(tmpdir(), 'apos-bot-brief-'));
    try {
      const input = {
        repoPath: 'C:/repo',
        goalId: 'GOAL-001',
        bot: { id: 'b', name: 'B' },
        events: ['x'],
        mode: 'plan' as const,
        leadWorktree: tree,
      };
      expect(botLeadBrief(input)).not.toContain('.apos/goals/GOAL-001/lead-log.md');
      expect(botLeadBrief(input)).not.toContain('.apos/goals/GOAL-001/execution.md');
      mkdirSync(join(tree, '.apos', 'goals', 'GOAL-001'), { recursive: true });
      writeFileSync(join(tree, '.apos', 'goals', 'GOAL-001', 'lead-log.md'), '# log');
      const brief = botLeadBrief(input);
      expect(brief).toContain('.apos/goals/GOAL-001/lead-log.md');
      expect(brief).toContain(`APOS_HOME=${process.env.APOS_HOME}`);
      expect(brief).toMatch(/You have no worker_done/);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
