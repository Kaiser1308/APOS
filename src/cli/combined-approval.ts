import { newEvent } from '../app/events.js';
import { GoalRegistryService } from '../app/registry.js';
import { goalApprovalBlockers, goalKind, parseAppetite } from '../domain/contracts.js';
import { UserError } from '../domain/errors.js';
import type { GoalState } from '../domain/transitions.js';
import type { ProjectJournal } from '../store/journal.js';
import { approvalSetupVersion, baselineMissingOf } from './goal-approval.js';
import type { CliContext } from './context.js';
import type { HumanConfirmation } from './human-confirm.js';

export type CombinedApproval = {
  id: string;
  /** The Goal kind this command is for (`bugfix`, `maintenance`); any other Goal goes through `goal approve`. */
  kind: 'bugfix' | 'maintenance';
  /** The Human command, for the confirmation and the messages (`bug approve`). */
  command: string;
  appetite: { size: string; maxWallMinutes: number; maxAttempts: number; overrun: string };
  flags: string[];
  onBehalf?: string;
  /** A confirmation the caller already has (`apos hotfix` asked once for the hotfix and this approval): not asked again. */
  confirmed?: HumanConfirmation;
  /** Looked at before the first event, with the setup version the Goal would be pinned to: what else refuses the approval. */
  problems?: (state: GoalState, setupVersion: number | undefined) => string[];
};

/**
 * Gate A, the appetite and gate B in one go, for a Goal kind that has its own short route (`bug approve`,
 * `maintenance approve`). Everything that could refuse is looked at before the first event, so a refusal leaves the log
 * as it was. Returns what the command prints.
 */
export async function approveInOneGo(
  ctx: CliContext,
  journal: ProjectJournal,
  input: CombinedApproval,
): Promise<{ setupVersion: number | undefined; message: string }> {
  const { id, command, kind } = input;
  const appetite = parseAppetite(input.appetite);
  const state = journal.getGoal(id);
  if (!state) throw new UserError(`Goal not found: ${id}`);
  if (goalKind(state.spec) !== kind)
    throw new UserError(
      `${id} is not a ${kind} Goal: approve it with \`apos goal approve ${id}\` and \`apos goal select ${id}\``,
    );
  if (state.status !== 'draft')
    throw new UserError(`${id} is ${state.status}: ${command} is for a Goal still in draft`);
  const blockers = goalApprovalBlockers(state.spec);
  if (blockers.length) throw new UserError(`${id} cannot be approved:\n- ${blockers.join('\n- ')}`);
  const registry = new GoalRegistryService(journal);
  const pending = registry.selectProblems(id);
  if (pending.length) throw new UserError(`${id} cannot be selected yet: ${pending.join('; ')}`);
  const setupVersion = approvalSetupVersion(ctx, journal, id, 'latest', input.flags);
  const extra = input.problems?.(state, setupVersion) ?? [];
  if (extra.length) throw new UserError(`${id} cannot be approved:\n- ${extra.join('\n- ')}`);
  const confirmation = input.confirmed ?? (await ctx.assertHuman(command, id, input.onBehalf));
  registry.approve(
    id,
    appetite,
    undefined,
    confirmation,
    setupVersion,
    input.flags,
    command,
    baselineMissingOf(journal, setupVersion),
  );
  journal.append(
    newEvent(id, 'appetite-set', {
      appetite,
      reason: `${command}: the default appetite for a ${kind === 'bugfix' ? 'bug' : 'maintenance change'}`,
      confirmation,
      via: command,
    }),
  );
  registry.select(id, confirmation, command);
  return {
    setupVersion,
    message: `Approved and selected ${id}${setupVersion === undefined ? '' : ` on setup v${setupVersion}`} (${appetite.size}, ${appetite.maxWallMinutes} min, ${appetite.maxAttempts} attempts)`,
  };
}
