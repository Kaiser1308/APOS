import type { GoalState } from '../domain/transitions.js';
import type { RuntimeAdapter, RuntimeRef } from '../runtime/orca.js';
import type { PackageRuntime, PackageRuntimeRef } from './packages.js';
import { currentLeadRef } from './lead.js';

/**
 * `includeLead`: a Goal revision must also wait for the Lead's turn to end. The Lead's own plan revision does not
 * (it is the caller), so `lead propose` leaves it false.
 */
export async function assertExecutionSettled(
  state: GoalState,
  runtime: RuntimeAdapter & Partial<PackageRuntime>,
  options: { includeLead?: boolean } = {},
): Promise<void> {
  if (state.dispatchIntent || state.resumeIntent)
    throw new Error('Reconcile uncertain Orca dispatch before changing the Goal or proposal');
  if (options.includeLead) {
    if (state.leadIntent) throw new Error('Reconcile the uncertain Lead dispatch before changing the Goal');
    if (
      state.lead &&
      !state.lead.settled &&
      (!state.runtimeRef || (state.runtimeRef as RuntimeRef).dispatchId !== state.lead.current)
    ) {
      const observation = await runtime.inspect(currentLeadRef(state.lead));
      if (!observation.outcome) throw new Error('The Lead must end its turn (worker_done) before the Goal changes');
    }
  }
  if (state.runtimeRef) {
    const observation = await runtime.inspect(state.runtimeRef as RuntimeRef);
    if (!observation.outcome) throw new Error('Solo Worker must settle before changing the Goal or proposal');
  }
  for (const item of Object.values(state.packages ?? {})) {
    if (item.dispatchIntent) throw new Error(`Reconcile uncertain package dispatch: ${item.spec.id}`);
    if (!item.runtimeRef) continue;
    if (
      !runtime.inspectPackage ||
      !['completed', 'failed'].includes(await runtime.inspectPackage(item.runtimeRef as PackageRuntimeRef))
    )
      throw new Error(`Package Worker must settle before replan: ${item.spec.id}`);
  }
}
