import { randomUUID } from 'node:crypto';
import { validatePackageGraph, parseWorkPackage, type WorkPackageSpec } from '../domain/packages.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { GoalRepository } from '../store/journal.js';

export type PackageRuntimeRef = { runId: string; taskId: string; dispatchId: string; owner: 'worker'; repoPath: string; terminal?: string };
export interface PackageRuntime {
  startPackage(input: { package: WorkPackageSpec; repoPath: string; idempotencyKey: string }): Promise<PackageRuntimeRef>;
  recoverPackage?(key: string): Promise<PackageRuntimeRef | undefined>;
}

export class PackageService {
  constructor(private readonly store: GoalRepository, private readonly runtime: PackageRuntime) {}

  private record(goalId: string, type: GoalEventType, data: unknown): void {
    this.store.append({ id: randomUUID(), goalId, type, data, at: new Date().toISOString() });
  }

  add(goalId: string, value: unknown): WorkPackageSpec {
    const spec = parseWorkPackage(value);
    this.record(goalId, 'package-added', spec);
    return spec;
  }

  ready(goalId: string): WorkPackageSpec[] {
    const state = this.store.getGoal(goalId);
    if (!state?.proposal || state.proposalApprovedVersion !== state.proposal.version || !['ready', 'executing'].includes(state.status)) throw new Error('Approved Multi-WP Goal required');
    const packages = Object.values(state.packages ?? {});
    validatePackageGraph(state.spec, state.proposal, packages.map(item => item.spec));
    return packages.filter(item => item.status === 'specified' && item.spec.dependencies.every(dep => state.packages?.[dep]?.status === 'verified')).map(item => item.spec);
  }

  async dispatchReady(goalId: string, repoPath: string): Promise<PackageRuntimeRef[]> {
    const ready = this.ready(goalId);
    const wave = ready.map(spec => {
      const key = randomUUID();
      this.record(goalId, 'package-dispatch-intended', { packageId: spec.id, key });
      return { spec, key };
    });
    const results = await Promise.allSettled(wave.map(async ({ spec, key }) => {
      const ref = await this.runtime.startPackage({ package: spec, repoPath, idempotencyKey: key });
      this.record(goalId, 'package-started', { packageId: spec.id, ref });
      return ref;
    }));
    const failed = results.find(item => item.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return results.map(item => (item as PromiseFulfilledResult<PackageRuntimeRef>).value);
  }

  async reconcile(goalId: string): Promise<{ packageId: string; state: 'recovered' | 'unknown' }[]> {
    const state = this.store.getGoal(goalId);
    if (!state?.proposal || state.proposal.mode !== 'multi-wp') throw new Error('Multi-WP Goal required');
    const results: { packageId: string; state: 'recovered' | 'unknown' }[] = [];
    for (const [packageId, item] of Object.entries(state.packages ?? {})) {
      if (item.status !== 'dispatching' || !item.dispatchIntent) continue;
      const ref = await this.runtime.recoverPackage?.(item.dispatchIntent);
      if (ref) {
        this.record(goalId, 'package-started', { packageId, ref });
        results.push({ packageId, state: 'recovered' });
      } else results.push({ packageId, state: 'unknown' });
    }
    return results;
  }
}
