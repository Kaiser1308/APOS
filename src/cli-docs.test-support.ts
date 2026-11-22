import type { Command } from 'commander';
import { buildProgram } from './cli-app.js';

export type CommandInfo = { path: string; flags: Set<string> };

/** Every command of the real tree (groups and leaves), by its full path (`goal approve`), with its own long flags. */
export function commandTree(program: Command = buildProgram({ home: '/home' })): Map<string, CommandInfo> {
  const found = new Map<string, CommandInfo>();
  const visit = (command: Command, prefix: string) => {
    for (const child of command.commands) {
      const path = `${prefix}${child.name()}`;
      found.set(path, {
        path,
        flags: new Set(
          child.options
            .filter(option => !option.hidden)
            .map(option => option.long)
            .filter((flag): flag is string => Boolean(flag)),
        ),
      });
      visit(child, `${path} `);
    }
  };
  visit(program, '');
  return found;
}

/** Longest known command that a run of words starts with: `goal approve GOAL-1` → `goal approve`. */
export function matchCommand(words: string[], tree: Map<string, CommandInfo>): string | undefined {
  for (let length = words.length; length > 0; length--) {
    const path = words.slice(0, length).join(' ');
    if (tree.has(path)) return path;
  }
  return undefined;
}

/** The global flags: `--repo` on the program, `--on-behalf` on a Human command. */
export const GLOBAL_FLAGS = new Set(['--repo', '--on-behalf', '--help', '--version']);
