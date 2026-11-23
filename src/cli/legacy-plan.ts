import { execFileSync } from 'node:child_process';
import { goalKind, type ExecutionProposal } from '../domain/contracts.js';
import { UserError } from '../domain/errors.js';
import { characterizeProposal, coverageProblems, planPathProblems } from '../domain/legacy.js';
import type { GoalState } from '../domain/transitions.js';
import { coverageOfRefactor } from '../app/characterized-gate.js';
import { filesAt } from '../app/git-files.js';
import { GitCommitInspector } from '../app/integration.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';
import { pinnedSetupOf } from './test-lock-wiring.js';

/** The sample Solo plan of `lead propose --characterize --goal <id>`: read from the Goal and its pinned setup, nothing invented. */
export function characterizePlan(
  ctx: CliContext,
  journal: ProjectJournal,
  flags: { goal?: string; base?: string },
): ExecutionProposal {
  if (!flags.goal) throw new UserError('--characterize needs --goal <id>');
  const state = journal.getGoal(flags.goal);
  if (!state) throw new UserError(`Goal not found: ${flags.goal}`);
  if (goalKind(state.spec) !== 'characterize')
    throw new UserError(`${flags.goal} is not a characterize Goal: write its plan with --file <json>`);
  const base = flags.base ?? execFileSync('git', ['-C', ctx.repo(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return characterizeProposal({
    goal: state.spec,
    version: (state.proposal?.version ?? 0) + 1,
    baseCommit: base,
    setup: pinnedSetupOf(ctx, journal, state.setupVersion),
  });
}

/**
 * What `goal approve` checks for a refactor before anything is written: the Goal is pinned to a setup (the characterized
 * tests are run through it), and every file its `paths` reach, in the repo as it is now, is covered by a closed characterize Goal.
 */
export function refactorApprovalProblems(ctx: CliContext, journal: ProjectJournal, state: GoalState): string[] {
  if (goalKind(state.spec) !== 'refactor') return [];
  const problems: string[] = [];
  if (!journal.setupHistory().approvals.length)
    problems.push(
      'a refactor is held to the tests a characterize Goal locked through the setup: approve a setup first',
    );
  const head = execFileSync('git', ['-C', ctx.repo(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const coverage = coverageOfRefactorAt(ctx, journal, state, head);
  return [...problems, ...coverageProblems(coverage, head.slice(0, 12))];
}

const coverageOfRefactorAt = (ctx: CliContext, journal: ProjectJournal, state: GoalState, commit: string) =>
  coverageOfRefactor(ctx.repo(), journal.listGoals(), {
    ...state,
    proposal: { ...state.proposal!, baseCommit: commit },
  });

/**
 * What `lead commit` checks for a refactor's plan, on the plan's base commit: the files its `paths` reach are still
 * covered there, the base holds every captured test (it contains the commit that locked them), and the plan's own `paths`
 * stay inside the Goal's (the Human approved those).
 */
export function refactorPlanProblems(ctx: CliContext, journal: ProjectJournal, state: GoalState): string[] {
  const proposal = state.proposal;
  if (goalKind(state.spec) !== 'refactor' || !proposal?.baseCommit) return [];
  const base = proposal.baseCommit;
  const coverage = coverageOfRefactor(ctx.repo(), journal.listGoals(), state);
  const problems = coverageProblems(coverage, base.slice(0, 12));
  const inspector = ctx.options.inspector ?? new GitCommitInspector();
  for (const { goalId, lock } of coverage.sources)
    if (!inspector.contains(ctx.repo(), lock.commit, base))
      problems.push(
        `the base ${base.slice(0, 12)} does not contain ${lock.commit.slice(0, 12)}, where ${goalId} locked the tests this refactor must keep: plan on a base that has them`,
      );
  const goalPaths = state.spec.paths ?? [];
  if (!proposal.paths?.length)
    problems.push('proposal.paths is required: a refactor says which files its package may change');
  else problems.push(...planPathProblems({ plan: proposal.paths, goalPaths, files: filesAt(ctx.repo(), base) }));
  return problems;
}
