import { describe, expect, it } from 'vitest';
import { confirmHuman, type ConfirmIo } from './human-confirm.js';

const io = (isTTY: boolean, answer = ''): ConfirmIo & { asked: string[] } => {
  const asked: string[] = [];
  return {
    isTTY,
    asked,
    prompt: async question => {
      asked.push(question);
      return answer;
    },
  };
};

describe('confirmHuman', () => {
  it('passes with --on-behalf without asking', async () => {
    const terminal = io(false);
    await expect(
      confirmHuman({ command: 'goal approve', subject: 'GOAL-1', onBehalf: 'item 12', io: terminal }),
    ).resolves.toEqual({ by: 'on-behalf', onBehalf: 'item 12' });
    expect(terminal.asked).toEqual([]);
  });

  it('passes when the person types the subject back in a TTY', async () => {
    const terminal = io(true, ' GOAL-1\n');
    await expect(confirmHuman({ command: 'goal approve', subject: 'GOAL-1', io: terminal })).resolves.toEqual({
      by: 'human',
    });
    expect(terminal.asked[0]).toContain('GOAL-1');
    expect(terminal.asked[0]).toContain('goal approve');
  });

  it('refuses a wrong id in a TTY', async () => {
    await expect(confirmHuman({ command: 'goal approve', subject: 'GOAL-1', io: io(true, 'GOAL-2') })).rejects.toThrow(
      /goal approve is a Human decision: confirm in an interactive terminal or pass --on-behalf/,
    );
  });

  it('refuses without a TTY and without --on-behalf, and does not ask', async () => {
    const terminal = io(false, 'GOAL-1');
    await expect(confirmHuman({ command: 'goal approve', subject: 'GOAL-1', io: terminal })).rejects.toThrow(
      /Human decision/,
    );
    expect(terminal.asked).toEqual([]);
  });

  it('treats a blank --on-behalf as absent', async () => {
    await expect(
      confirmHuman({ command: 'outcome close', subject: 'GOAL-1', onBehalf: '  ', io: io(false) }),
    ).rejects.toThrow(/Human decision/);
  });
});
