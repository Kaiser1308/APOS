import { PackageService, type PackageRuntime, type PackageRuntimeRef } from './packages.js';
import { SoloService } from './solo.js';
import type { RuntimeAdapter, RuntimeRef } from '../runtime/orca.js';
import type { GoalRepository } from '../store/journal.js';
import { randomUUID } from 'node:crypto';
import { SoloSupervisor, type SupervisorOptions } from './supervisor.js';

export type ControllerTick = { goalId: string; dispatched: string[]; recovered: string[]; unresolved: string[]; resumed: string[]; settled: string[]; inboxPending: string[]; errors: string[]; supervised: string[] };

export class ControllerService {
  constructor(private readonly store: GoalRepository, private readonly runtime: RuntimeAdapter & PackageRuntime, private readonly options: SupervisorOptions = {}) {}

  private async consumeInbox(goalId: string, result: ControllerTick): Promise<void> {
    if (!this.runtime.checkRun || !this.runtime.ackRun || !this.runtime.retainWorker) return;
    const state = this.store.getGoal(goalId);
    if (!state || !['executing', 'blocked'].includes(state.status)) return;
    const refs = [state.runtimeRef, ...Object.values(state.packages ?? {}).map(item => item.runtimeRef)].filter(Boolean) as (RuntimeRef | PackageRuntimeRef)[];
    const runId = refs[0]?.runId;
    if (!runId) return;
    const delivery = await this.runtime.checkRun(runId);
    if (!delivery.deliveryId) return;
    for (const message of delivery.messages) {
      if (message.type === 'status' || message.type === 'heartbeat') continue;
      if (message.type !== 'worker_done') { result.inboxPending.push(`${message.type}:${message.id}`); continue; }
      let payload = message.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { result.inboxPending.push(`invalid payload:${message.id}`); continue; }
      }
      const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const dispatchId = message.dispatchId ?? message.dispatch_id ?? body.dispatchId ?? body.dispatch_id;
      const ref = refs.find(item => item.dispatchId === dispatchId);
      if (!ref) { result.inboxPending.push(`unknown Dispatch:${message.id}`); continue; }
      const outcome = ref.owner === 'lead'
        ? (await this.runtime.inspect(ref)).outcome
        : await this.runtime.inspectPackage?.(ref);
      if (outcome !== 'completed' && outcome !== 'failed') { result.inboxPending.push(`unsettled:${message.id}`); continue; }
      await this.runtime.retainWorker(ref.dispatchId);
      if (!this.store.getGoal(goalId)?.settlements?.[ref.dispatchId]) {
        this.store.append({ id: randomUUID(), goalId, type: 'worker-settled', data: { dispatchId: ref.dispatchId, outcome }, at: new Date().toISOString() });
        result.settled.push(`${ref.dispatchId}:${outcome}`);
      }
    }
    if (!result.inboxPending.length) await this.runtime.ackRun(runId, delivery.deliveryId);
  }

  async tick(repoPath: string): Promise<ControllerTick[]> {
    const results: ControllerTick[] = [];
    for (const snapshot of this.store.listGoals()) {
      const goalId = snapshot.spec.id;
      if (!snapshot.proposal || !['ready', 'executing', 'blocked'].includes(snapshot.status)) continue;
      const result: ControllerTick = { goalId, dispatched: [], recovered: [], unresolved: [], resumed: [], settled: [], inboxPending: [], errors: [], supervised: [] };
      if (snapshot.status === 'blocked') {
        try { await this.consumeInbox(goalId, result); }
        catch (error) { result.errors.push(`inbox: ${error instanceof Error ? error.message : String(error)}`); }
        results.push(result);
        continue;
      }
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
      try { await this.consumeInbox(goalId, result); }
      catch (error) { result.errors.push(`inbox: ${error instanceof Error ? error.message : String(error)}`); }
      if (snapshot.proposal.mode !== 'multi-wp') {
        try { result.supervised.push(...await new SoloSupervisor(this.store, this.runtime, this.options).step(goalId, repoPath)); }
        catch (error) { result.errors.push(`supervisor: ${error instanceof Error ? error.message : String(error)}`); }
      }
      results.push(result);
    }
    return results;
  }
}
