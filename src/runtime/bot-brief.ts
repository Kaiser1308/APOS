import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BotWakeInput } from '../ports/runtime.js';
import { aposCommand, oneLine, roleSkill } from './brief.js';

/** Commands a Human keeps; APOS refuses each of them from the chat of a bot that holds a Lead. */
export const HUMAN_ONLY = [
  'goal approve/select/appetite',
  'lead start/wake',
  'handoff',
  'gate run --base',
  'gate confirm',
  'review submit',
  'blocker resolve',
  'outcome close/revise/stop',
  'profile set/reset',
  'execution abandon-intent',
];

/**
 * The mail that wakes a bot holding a Goal's Lead. It stands on its own every time: a bot keeps no dispatch, pinned
 * skill or worktree between mails. The bot coordinates through APOS commands only, so each decision is an event, and
 * it never writes code: Solo has a controller-dispatched owner, a Multi-WP Goal integrates on a verified package head.
 */
export function botLeadBrief(input: BotWakeInput): string {
  const apos = aposCommand(input.repoPath);
  const goal = input.goalId;
  // Only files that exist: before a plan there is no execution.md, before a decision no lead-log.md (seen live).
  const present = (tree: string) =>
    [`.apos/goals/${goal}/execution.md`, `.apos/goals/${goal}/lead-log.md`].filter(path =>
      existsSync(join(tree, path)),
    );
  const where = input.leadWorktree
    ? `The Lead worktree is ${input.leadWorktree}: read ${[roleSkill('lead'), ...present(input.leadWorktree)].join(', ')} there (lead-log.md is a generated reading copy of the event log).`
    : `Read ${roleSkill('lead')} and .apos/goals/${goal}/ in the managed repo.`;
  // The bot's chat does not inherit the controller's environment: name the controller home when it is not the default.
  const home = process.env.APOS_HOME
    ? [
        `Set the environment variable APOS_HOME=${process.env.APOS_HOME} for every APOS command (PowerShell: $env:APOS_HOME='${process.env.APOS_HOME}').`,
      ]
    : [];
  const mode =
    input.mode === 'multi'
      ? [
          `See where packages stand with ${apos} package list ${goal}. Decide with package approve/hold/add/remove/revise/decide-failure/evidence/verify, each with --reason where it takes one. Answer a Worker's question with ${apos} package answer ${goal} <packageId> --message-id <id> --text-file <file> --reason <why>; the controller sends it. You never send, reply or start workers through Orca yourself.`,
          `Integration is the head of a verified package: the head of the last package of a sequential chain, or of an integration package you add for a Worker when branches must be merged. Ask the controller to gate it with ${apos} integration gate ${goal} --commit <that head> --reason <why>; after a passing Goal review run ${apos} integration complete ${goal} --commit <that head>.`,
          `When the Goal review asks for changes, add a fix package (package add) or revise the last package (package revise, the review's comments in its contract and --reason) so its owner resumes; never fix it yourself.`,
        ]
      : input.mode === 'plan'
        ? [
            `Plan under the lead skill: ${apos} lead propose --file <execution.json>, then ${apos} lead commit ${goal}. A Solo plan gets an owner the controller dispatches; you check its delivery, you do not write it.`,
          ]
        : [
            `The controller's Solo owner writes the code and the controller gates and reviews it; you are the checker. Read ${apos} execution status ${goal} and act only through APOS commands.`,
          ];
  return [
    `${goal}: you are the APOS Lead of this Goal, as an Orca bot. You never write, commit or merge code yourself; every decision goes through an APOS command, run as ${apos} <command>, so it is recorded in the event log.`,
    ...home,
    where,
    ...mode,
    `These are Human decisions and APOS refuses them from your chat: ${HUMAN_ONLY.join(', ')}. When one is needed, say so to your owner.`,
    'You have no worker_done: when this batch is handled, stop; reply to this mail only if your owner must decide something.',
    'Events:',
    ...input.events.map((item, index) => `(${index + 1}) ${oneLine(item)}`),
  ].join('\n');
}
