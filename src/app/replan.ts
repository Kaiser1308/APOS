import type { GoalState } from '../domain/transitions.js';
import type { RuntimeAdapter, RuntimeRef } from '../runtime/orca.js';
import type { PackageRuntime, PackageRuntimeRef } from './packages.js';

export async function assertExecutionSettled(state: GoalState, runtime: RuntimeAdapter & Partial<PackageRuntime>): Promise<void> {
  if (state.dispatchIntent || state.resumeIntent) throw new Error('Reconcile uncertain Orca dispatch before changing the Goal or proposal');
  if (state.runtimeRef) {
    const observation = await runtime.inspect(state.runtimeRef as RuntimeRef);
    if (!observation.outcome) throw new Error('Solo Worker must settle before changing the Goal or proposal');
  }
  for (const item of Object.values(state.packages ?? {})) {
    if (item.dispatchIntent) throw new Error(`Reconcile uncertain package dispatch: ${item.spec.id}`);
    if (!item.runtimeRef) continue;
    if (!runtime.inspectPackage || !['completed', 'failed'].includes(await runtime.inspectPackage(item.runtimeRef as PackageRuntimeRef))) throw new Error(`Package Worker must settle before replan: ${item.spec.id}`);
  }
}
