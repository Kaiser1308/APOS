import { execFileSync } from 'node:child_process';
import { goalKind, type ExecutionProposal } from '../domain/contracts.js';
import { UserError } from '../domain/errors.js';
import { maintenanceProposal } from '../domain/maintenance.js';
import type { GoalState } from '../domain/transitions.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';
import { pinnedSetupOf } from './test-lock-wiring.js';

/** The sample Solo plan of `lead propose --maintenance --goal <id>`: read from the Goal and its pinned setup, nothing invented. */
export function maintenancePlan(
  ctx: CliContext,
  journal: ProjectJournal,
  flags: { goal?: string; base?: string },
): ExecutionProposal {
  if (!flags.goal) throw new UserError('--maintenance needs --goal <id>');
  const state = journal.getGoal(flags.goal);
  if (!state) throw new UserError(`Goal not found: ${flags.goal}`);
  if (goalKind(state.spec) !== 'maintenance')
    throw new UserError(`${flags.goal} is not a maintenance Goal: write its plan with --file <json>`);
  const setup = pinnedSetupOf(ctx, journal, state.setupVersion);
  if (!setup) throw new UserError(`${flags.goal} is not pinned to a setup: the manifests come from the setup`);
  const base = flags.base ?? execFileSync('git', ['-C', ctx.repo(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return maintenanceProposal({
    goal: state.spec,
    version: (state.proposal?.version ?? 0) + 1,
    baseCommit: base,
    setup,
  });
}

/** What `lead commit` refuses for a maintenance Goal: it has one package and no Tester. */
export function maintenancePlanProblems(state: GoalState): string[] {
  if (goalKind(state.spec) !== 'maintenance') return [];
  return state.proposal?.mode === 'multi-wp'
    ? ['a maintenance Goal is one Solo package: it has no criterion to split between packages']
    : [];
}
