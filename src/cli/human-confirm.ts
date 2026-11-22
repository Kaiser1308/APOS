import { createInterface } from 'node:readline';
import { UserError } from '../domain/errors.js';

export type HumanConfirmation = { by: 'human' | 'on-behalf'; onBehalf?: string };

export type ConfirmIo = {
  isTTY: boolean;
  /** Asks one question on the terminal and resolves with the typed line. */
  prompt(question: string): Promise<string>;
};

/** The real terminal. The question goes to stderr so a piped stdout stays clean. */
export function terminalIo(): ConfirmIo {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    prompt: question =>
      new Promise(resolve => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question, answer => {
          rl.close();
          resolve(answer);
        });
      }),
  };
}

/**
 * A Human decision needs a person: typing `subject` back in a terminal, or an explicit `--on-behalf "<why>"`
 * that is written into the log. An agent, script or pipe has no terminal and no reason to pass the flag.
 */
export async function confirmHuman(opts: {
  command: string;
  subject: string;
  onBehalf?: string;
  io: ConfirmIo;
}): Promise<HumanConfirmation> {
  const onBehalf = opts.onBehalf?.trim();
  if (onBehalf) return { by: 'on-behalf', onBehalf };
  const refuse = () =>
    new UserError(
      `${opts.command} is a Human decision: confirm in an interactive terminal or pass --on-behalf "<why>"`,
    );
  if (!opts.io.isTTY) throw refuse();
  const typed = await opts.io.prompt(`Gõ lại ${opts.subject} để xác nhận ${opts.command}: `);
  if (typed.trim() !== opts.subject) throw refuse();
  return { by: 'human' };
}

export const ON_BEHALF_FLAGS = '--on-behalf <text>';
export const ON_BEHALF_HELP = "Human decision taken on the Human's explicit say-so elsewhere (recorded in the log)";
