import { execFileSync } from 'node:child_process';
import { bugPart, bugfixProposal } from '../domain/bugfix.js';
import { goalKind, type ExecutionProposal } from '../domain/contracts.js';
import { UserError } from '../domain/errors.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';
import { pinnedSetupOf } from './test-lock-wiring.js';

/** The sample Solo plan of `lead propose --bugfix --goal <id>`: read from the Goal and its pinned setup, nothing invented. */
export function bugfixPlan(
  ctx: CliContext,
  journal: ProjectJournal,
  flags: { goal?: string; base?: string; stub: string[] },
): ExecutionProposal {
  if (!flags.goal) throw new UserError('--bugfix needs --goal <id>');
  const state = journal.getGoal(flags.goal);
  if (!state) throw new UserError(`Goal not found: ${flags.goal}`);
  if (goalKind(state.spec) !== 'bugfix')
    throw new UserError(`${flags.goal} is not a bugfix Goal: write its plan with --file <json>`);
  const setup = pinnedSetupOf(ctx, journal, state.setupVersion);
  const part = setup ? bugPart(setup, state.spec.part) : undefined;
  const base = flags.base ?? execFileSync('git', ['-C', ctx.repo(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return bugfixProposal({
    goal: state.spec,
    version: (state.proposal?.version ?? 0) + 1,
    baseCommit: base,
    ...(setup && part ? { root: setup.parts[part]!.root } : {}),
    stubs: flags.stub,
  });
}
