import { currentLeadRef } from './lead.js';
import { GitCommitInspector, IntegrationService } from './integration.js';
import type { GateService } from './gate-service.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { RuntimeAdapter } from '../ports/runtime.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { GoalState } from '../domain/transitions.js';
import { manualWaitUnchanged } from './supervision.js';

export function reviewRun(state: GoalState): string | undefined {
  return (
    state.leadTerminal?.runId ??
    Object.values(state.packages ?? {})
      .map(item => item.runtimeRef?.runId)
      .find(Boolean)
  );
}

export function coordinationNotices(state: GoalState): string[] {
  const events: string[] = [];
  for (const item of Object.values(state.packages ?? {})) {
    if (item.status === 'blocked' && item.blocker?.note.startsWith('Worker reported failed'))
      events.push(`package ${item.spec.id} v${item.spec.version} attempt ${item.attempts} failed`);
    const commit = item.gate?.deliveryCommit ?? item.evidence.at(-1)?.commitRef;
    if (item.status === 'verified' && commit)
      events.push(`package ${item.spec.id} v${item.spec.version} attempt ${item.attempts} verified at ${commit}`);
    if (item.leadDecisionRequired)
      events.push(
        `package ${item.spec.id} v${item.spec.version} attempt ${item.attempts} needs Lead decision: ${item.finding ?? 'retry budget exhausted'}`,
      );
    if (
      state.leadApprovalRequired !== false &&
      (item.status === 'specified' || item.status === 'stale') &&
      item.dispatchApproved === undefined &&
      item.spec.dependencies.length &&
      item.spec.dependencies.every(dep => state.packages?.[dep]?.status === 'verified')
    )
      events.push(`package ${item.spec.id} v${item.spec.version} awaits Lead dispatch approval`);
  }
  return events;
}

/** Gate only a settled Lead turn whose head contains every verified package. */
export async function gateSettledLead(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  gate: GateService,
  goalId: string,
  repoPath: string,
  inspector: CommitInspector = new GitCommitInspector(),
): Promise<string[]> {
  const state = store.getGoal(goalId);
  // A bot Lead asks for its integration gate (`apos integration gate`); its stopped Lead dispatch has no turn to gate.
  if (!state?.lead || state.leadBot || state.integration || state.reviewDispatch || state.reviewIntent) return [];
  const packages = Object.values(state.packages ?? {});
  if (!packages.length || !packages.every(item => item.status === 'verified')) return [];
  const ref = currentLeadRef(state.lead);
  const observation = await runtime.inspect(ref);
  if (observation.outcome !== 'completed') return [];
  const head = await runtime.deliveryHead?.(ref);
  if (!head) return [];
  if (state.gate?.deliveryCommit.toLowerCase() === head.toLowerCase()) {
    if (state.gate.result !== 'pending' || manualWaitUnchanged(store, state, head)) return [];
  }
  let commits: string[];
  try {
    commits = new IntegrationService(store, inspector).prepare(goalId, repoPath).commits;
  } catch {
    return [];
  }
  if (!commits.every(commit => inspector.contains(repoPath, commit, head))) return [];
  const report = gate.run(goalId, repoPath, { deliveryCommit: head });
  return [`integration gate ${report.result} on ${head}`];
}
