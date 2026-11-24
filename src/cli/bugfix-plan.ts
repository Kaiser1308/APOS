import { execFileSync } from 'node:child_process';
import { bugPart, bugfixProposal } from '../domain/bugfix.js';
import { goalKind, type ExecutionProposal } from '../domain/contracts.js';
import { UserError } from '../domain/errors.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';
import { pinnedSetupOf } from './test-lock-wiring.js';

const gitLines = (repo: string, args: string[]): string[] =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);

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
  const hotfix = state.hotfix;
  if (hotfix && flags.base && flags.base.toLowerCase() !== hotfix.before)
    throw new UserError(
      `${flags.goal} answers for the hotfix ${hotfix.commit}: its plan starts from the commit before it, ${hotfix.before}, where the bug is red`,
    );
  const base =
    hotfix?.before ??
    flags.base ??
    execFileSync('git', ['-C', ctx.repo(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // A hotfix Goal may change what the hotfix changed, and its stubs are those files the hotfix modified (they exist on `before`).
  const touched = hotfix
    ? gitLines(ctx.repo(), ['diff', '--name-only', '--no-renames', hotfix.before, hotfix.commit])
    : [];
  const modified = hotfix
    ? gitLines(ctx.repo(), ['diff', '--name-only', '--no-renames', '--diff-filter=M', hotfix.before, hotfix.commit])
    : [];
  return bugfixProposal({
    goal: state.spec,
    version: (state.proposal?.version ?? 0) + 1,
    baseCommit: base,
    ...(setup && part ? { root: setup.parts[part]!.root } : {}),
    ...(hotfix ? { paths: touched } : {}),
    stubs: flags.stub.length || !hotfix || state.spec.reproHint ? flags.stub : modified.length ? modified : touched,
  });
}
