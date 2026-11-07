import { PackageService, type PackageRuntime, type PackageRuntimeRef } from './packages.js';
import { SoloService } from './solo.js';
import type { RuntimeAdapter } from '../runtime/orca.js';
import type { GoalRepository } from '../store/journal.js';

export type ControllerTick = { goalId: string; dispatched: string[]; recovered: string[]; unresolved: string[]; resumed: string[]; errors: string[] };

export class ControllerService {
  constructor(private readonly store: GoalRepository, private readonly runtime: RuntimeAdapter & PackageRuntime) {}

  async tick(repoPath: string): Promise<ControllerTick[]> {
    const results: ControllerTick[] = [];
    for (const snapshot of this.store.listGoals()) {
      const goalId = snapshot.spec.id;
      if (!snapshot.proposal || !['ready', 'executing'].includes(snapshot.status)) continue;
      const result: ControllerTick = { goalId, dispatched: [], recovered: [], unresolved: [], resumed: [], errors: [] };
      if (snapshot.proposal.mode === 'multi-wp') {
        const service = new PackageService(this.store, this.runtime);
        try {
          for (const item of await service.reconcile(goalId)) (item.state === 'recovered' ? result.recovered : result.unresolved).push(item.packageId);
          const refs = await service.dispatchReady(goalId, repoPath);
          result.dispatched.push(...refs.map((ref: PackageRuntimeRef) => ref.dispatchId));
          const state = this.store.getGoal(goalId)!;
          for (const [packageId, item] of Object.entries(state.packages ?? {})) {
            if (item.status !== 'stale' || !item.spec.dependencies.every(dep => state.packages?.[dep]?.status === 'verified')) continue;
            const prior = item.runtimeRef as PackageRuntimeRef | undefined;
            if (!prior || !this.runtime.inspectPackage || !['completed', 'failed'].includes(await this.runtime.inspectPackage(prior))) continue;
            try { result.resumed.push((await service.resumeStale(goalId, packageId)).dispatchId); }
            catch (error) { result.errors.push(`${packageId}: ${error instanceof Error ? error.message : String(error)}`); }
          }
        } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
      } else {
        const service = new SoloService(this.store, this.runtime);
        try {
          if (snapshot.status === 'ready') result.dispatched.push((await service.start(goalId, repoPath)).dispatchId);
          else result.unresolved.push(`Solo dispatch ${await service.reconcile(goalId)}`);
        } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
      }
      results.push(result);
    }
    return results;
  }
}
