import { newEvent } from './events.js';
import type { GoalState } from '../domain/transitions.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { RuntimeAdapter } from '../ports/runtime.js';

/** Every Orca Run the Goal's agents work in: its Lead's, its owner's, its packages', its reviewer's. */
export function goalRuns(state: GoalState): string[] {
  return [
    ...new Set(
      [
        state.lead?.ref.runId,
        state.runtimeRef?.runId,
        state.leadTerminal?.runId,
        state.reviewDispatch?.runId,
        state.handoffIntent?.runId,
        ...Object.values(state.packages ?? {}).map(item => item.runtimeRef?.runId),
      ].filter((item): item is string => Boolean(item)),
    ),
  ];
}

/**
 * The Goal's Runs this controller no longer coordinates. Orca lets only a Run's coordinator start workers in it and
 * read its mail, and taking a Run back (`run-use`) unbinds every other Run the caller holds, so the controller never
 * takes one back: it tells the Human once per Run and holder, and leaves the Goal alone until the Run is its own again.
 */
export async function driftedRuns(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  goalId: string,
  controller: string,
): Promise<string[]> {
  const state = store.getGoal(goalId);
  if (!state || !runtime.runCoordinator) return [];
  const drifted: string[] = [];
  for (const runId of goalRuns(state)) {
    const holder = await runtime.runCoordinator(runId);
    if (holder === controller) continue;
    drifted.push(`Run ${runId} is coordinated by ${holder ?? 'nobody'}, not this controller (${controller})`);
    const seen = store.events(goalId).some(item => {
      const data = item.data as { kind?: string; runId?: string; holder?: string | null } | null;
      return (
        item.type === 'human-notified' &&
        data?.kind === 'run-coordinator-drift' &&
        data.runId === runId &&
        data.holder === holder
      );
    });
    if (seen) continue;
    store.append(
      newEvent(goalId, 'human-notified', {
        kind: 'run-coordinator-drift',
        goalId,
        runId,
        holder,
        controller,
        note: `Orca Run ${runId} of ${goalId} is coordinated by ${holder ?? 'no terminal'}, not by the controller terminal ${controller}, so the controller cannot start its workers or read its mail and leaves ${goalId} alone. It does not take the Run back: \`orca orchestration run-use\` would unbind every other Run the controller holds. ${holder ? `If ${holder} is the terminal an earlier \`apos controller watch\` ran in, run the controller there again.` : `Nobody holds it (a Run from before APOS took over all dispatching): only if ${goalId} is the controller's only Goal in flight, run \`orca orchestration run-use --id ${runId}\` in the controller terminal.`} Otherwise finish or stop ${goalId} and start it again.`,
      }),
    );
  }
  return drifted;
}
