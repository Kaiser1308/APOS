import { PackageService, type PackageRuntime, type PackageRuntimeRef } from './packages.js';
import { SoloService } from './solo.js';
import type { RuntimeAdapter, RuntimeRef } from '../runtime/orca.js';
import type { GoalRepository } from '../store/journal.js';
import { randomUUID } from 'node:crypto';

export type ControllerTick = { goalId: string; dispatched: string[]; recovered: string[]; unresolved: string[]; resumed: string[]; settled: string[]; errors: string[] };

export class ControllerService {
  constructor(private readonly store: GoalRepository, private readonly runtime: RuntimeAdapter & PackageRuntime) {}

  async tick(repoPath: string): Promise<ControllerTick[]> {
    const results: ControllerTick[] = [];
    for (const snapshot of this.store.listGoals()) {
      const goalId = snapshot.spec.id;
      if (!snapshot.proposal || !['ready', 'executing'].includes(snapshot.status)) continue;
      const result: ControllerTick = { goalId, dispatched: [], recovered: [], unresolved: [], resumed: [], settled: [], errors: [] };
      if (snapshot.proposal.mode === 'multi-wp') {
        const service = new PackageService(this.store, this.runtime);
        try {
          for (const item of await service.reconcile(goalId)) (item.state === 'recovered' ? result.recovered : result.unresolved).push(item.packageId);
          const refs = await service.dispatchReady(goalId, repoPath);
          result.dispatched.push(...refs.map((ref: PackageRuntimeRef) => ref.dispatchId));
          const state = this.store.getGoal(goalId)!;
          for (const [packageId, item] of Object.entries(state.packages ?? {})) {
            if (item.status === 'executing' && item.runtimeRef && this.runtime.inspectPackage && !state.settlements?.[(item.runtimeRef as PackageRuntimeRef).dispatchId]) {
              const ref = item.runtimeRef as PackageRuntimeRef;
              const outcome = await this.runtime.inspectPackage(ref);
              if (outcome === 'completed' || outcome === 'failed') {
                this.store.append({ id: randomUUID(), goalId, type: 'worker-settled', data: { dispatchId: ref.dispatchId, outcome }, at: new Date().toISOString() });
                result.settled.push(`${packageId}:${outcome}`);
              }
            }
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
          else {
            const observed = await service.reconcile(goalId);
            if (observed === 'unverifiable') result.unresolved.push('Solo dispatch unverifiable');
            const current = this.store.getGoal(goalId)!;
            if (current.runtimeRef && !current.settlements?.[(current.runtimeRef as RuntimeRef).dispatchId]) {
              const observation = await this.runtime.inspect(current.runtimeRef as RuntimeRef);
              if (observation.outcome) {
                this.store.append({ id: randomUUID(), goalId, type: 'worker-settled', data: { dispatchId: observation.ref.dispatchId, outcome: observation.outcome }, at: new Date().toISOString() });
                result.settled.push(`solo:${observation.outcome}`);
              }
            }
          }
        } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
      }
      results.push(result);
    }
    return results;
  }
}
