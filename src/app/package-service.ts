import { randomUUID } from 'node:crypto';
import {
  validatePackageGraph,
  parsePackageEvidence,
  parseWorkPackage,
  type PackageEvidence,
  type WorkPackageSpec,
} from '../domain/packages.js';
import { newEvent } from './events.js';
import { attemptLimit, type GoalEventType } from '../domain/transitions.js';
import type { PackageBlocker } from '../domain/transitions.js';

import { OrcaRefused } from '../runtime/orca/exec.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { PackageRuntime } from '../ports/runtime.js';
import type { PackageRuntimeRef } from '../domain/runtime-refs.js';
import { multiWallTimeExpired } from './multi-budget.js';

export class PackageService {
  constructor(
    private readonly store: GoalRepository,
    private readonly runtime: PackageRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  private record(goalId: string, type: GoalEventType, data: unknown): void {
    this.store.append(newEvent(goalId, type, data));
  }

  private initializePolicy(goalId: string): void {
    const state = this.store.getGoal(goalId);
    if (
      state?.proposal?.mode === 'multi-wp' &&
      ['ready', 'executing'].includes(state.status) &&
      state.leadApprovalRequired === undefined
    )
      this.record(goalId, 'package-approval-policy-initialized', {
        enabled: true,
        reason: 'Default Lead approval for dependent packages',
      });
  }

  add(goalId: string, value: unknown, reason?: string): WorkPackageSpec {
    const spec = parseWorkPackage(value);
    const state = this.store.getGoal(goalId);
    if (state?.status !== 'planned') this.initializePolicy(goalId);
    this.record(
      goalId,
      state?.status === 'planned' && reason === undefined ? 'package-added' : 'package-plan-added',
      state?.status === 'planned' && reason === undefined ? spec : { spec, reason },
    );
    return spec;
  }

  remove(goalId: string, packageId: string, reason: string): void {
    this.initializePolicy(goalId);
    this.record(goalId, 'package-removed', { packageId, reason });
  }

  approveDispatch(goalId: string, packageId: string, reason: string): void {
    this.initializePolicy(goalId);
    this.record(goalId, 'package-dispatch-approved', { packageId, reason });
  }

  holdDispatch(goalId: string, packageId: string, reason: string): void {
    this.initializePolicy(goalId);
    this.record(goalId, 'package-dispatch-held', { packageId, reason });
  }

  setApprovalPolicy(goalId: string, enabled: boolean, reason: string): void {
    this.initializePolicy(goalId);
    this.record(goalId, 'package-approval-policy-set', { enabled, reason });
  }

  decideFailure(goalId: string, packageId: string, decision: 'retry' | 'hold' | 'escalate', reason: string): void {
    this.initializePolicy(goalId);
    this.record(goalId, 'package-failure-decided', { packageId, decision, reason });
    reconcileFailureEscalations(this.store, goalId);
  }

  outOfTime(goalId: string): boolean {
    return multiWallTimeExpired(this.store, goalId, this.now);
  }

  revise(goalId: string, value: unknown, reason: string): WorkPackageSpec {
    const spec = parseWorkPackage(value);
    this.initializePolicy(goalId);
    this.record(goalId, 'package-revised', { spec, reason });
    return spec;
  }

  submitEvidence(goalId: string, value: unknown): PackageEvidence {
    const evidence = parsePackageEvidence(value);
    this.record(goalId, 'package-evidence-submitted', evidence);
    return evidence;
  }

  async verify(goalId: string, packageId: string): Promise<void> {
    const state = this.store.getGoal(goalId);
    const item = state?.packages?.[packageId];
    if (item?.status !== 'executing' || !item.runtimeRef)
      throw new Error('Executing package and Orca dispatch required');
    if ((await this.runtime.inspectPackage?.(item.runtimeRef)) !== 'completed')
      throw new Error('Orca Worker must complete before package verification');
    if (state?.proposal?.risks.length) {
      const latest = [...state.reviews]
        .reverse()
        .find(
          review =>
            review.subject === 'package' &&
            review.packageId === packageId &&
            review.packageVersion === item.spec.version,
        );
      if (latest?.result !== 'pass' || !item.evidence.some(evidence => evidence.commitRef === latest.commitRef))
        throw new Error('Passing independent package review required');
    }
    this.record(goalId, 'package-verified', { packageId });
  }

  recordBlocker(goalId: string, packageId: string, kind: PackageBlocker['kind'], note: string): void {
    this.record(goalId, 'package-blocked', { packageId, blocker: { kind, note } });
  }

  unblock(goalId: string, packageId: string, resolution: string): void {
    this.record(goalId, 'package-unblocked', { packageId, resolution });
  }

  async resumeStale(goalId: string, packageId: string): Promise<PackageRuntimeRef> {
    this.initializePolicy(goalId);
    const state = this.store.getGoal(goalId);
    const item = state?.packages?.[packageId];
    if (item?.status !== 'stale' || !item.runtimeRef) throw new Error('Stale package with prior owner required');
    if (this.outOfTime(goalId)) throw new Error('Multi-WP wall time exhausted; Human decision required');
    if (item.leadDecisionRequired) throw new Error('Lead decision required before retry');
    if (!item.spec.dependencies.every(dep => state?.packages?.[dep]?.status === 'verified'))
      throw new Error('Package dependencies are not verified');
    if (item.spec.dependencies.length && state?.leadApprovalRequired !== false && !item.dispatchApproved)
      throw new Error('Lead approval required before dependent package resume');
    if (state && item.attempts >= attemptLimit(state)) {
      this.record(goalId, 'package-retry-exhausted', { packageId });
      throw new Error('Package retry budget exhausted; Lead decision required');
    }
    const prior = item.runtimeRef;
    if (!['completed', 'failed'].includes((await this.runtime.inspectPackage?.(prior)) ?? 'unverifiable'))
      throw new Error('Prior Worker dispatch must be settled');
    if (!this.runtime.resumePackage) throw new Error('Runtime cannot resume package owner');
    const dependencyCommits = item.spec.dependencies.map(dep => {
      const dependency = state!.packages![dep];
      const commit = dependency.gate?.deliveryCommit ?? dependency.evidence.at(-1)?.commitRef;
      if (!commit) throw new Error(`Verified dependency ${dep} has no commit`);
      return commit;
    });
    const key = randomUUID();
    this.record(goalId, 'package-resume-intended', { packageId, key });
    let ref: PackageRuntimeRef;
    try {
      ref = await this.runtime.resumePackage({
        package: item.spec,
        prior,
        idempotencyKey: key,
        finding: item.finding,
        attempt: item.attempts + 1,
        dependencyCommits,
      });
    } catch (error) {
      // A refusal is definitive (nothing was created), so the package returns to stale instead of waiting on an intent that cannot resolve.
      if (error instanceof OrcaRefused)
        this.record(goalId, 'intent-abandoned', { key, reason: `Orca refused: ${error.code}` });
      throw error;
    }
    this.record(goalId, 'package-resumed', { packageId, ref });
    return ref;
  }

  ready(goalId: string): WorkPackageSpec[] {
    const state = this.store.getGoal(goalId);
    if (
      !state?.proposal ||
      state.proposalApprovedVersion !== state.proposal.version ||
      !['ready', 'executing'].includes(state.status)
    )
      throw new Error('Approved Multi-WP Goal required');
    const packages = Object.values(state.packages ?? {});
    validatePackageGraph(
      state.spec,
      state.proposal,
      packages.map(item => item.spec),
    );
    return packages
      .filter(
        item =>
          item.status === 'specified' &&
          (!item.spec.dependencies.length || state.leadApprovalRequired === false || item.dispatchApproved) &&
          item.spec.dependencies.every(dep => state.packages?.[dep]?.status === 'verified'),
      )
      .map(item => item.spec);
  }

  async dispatchReady(goalId: string, repoPath: string): Promise<PackageRuntimeRef[]> {
    this.initializePolicy(goalId);
    if (this.outOfTime(goalId)) return [];
    const ready = this.ready(goalId);
    const packages = this.store.getGoal(goalId)?.packages ?? {};
    const wave = ready.map(spec => {
      const key = randomUUID();
      this.record(goalId, 'package-dispatch-intended', { packageId: spec.id, key });
      // Seen live: a dependent package started from the repo HEAD without its dependency's code, so its gate failed.
      const dependencyCommits = spec.dependencies
        .map(dep => packages[dep]?.gate?.deliveryCommit ?? packages[dep]?.evidence.at(-1)?.commitRef)
        .filter((commit): commit is string => Boolean(commit));
      return { spec, key, dependencyCommits };
    });
    const results = await Promise.allSettled(
      wave.map(async ({ spec, key, dependencyCommits }) => {
        const ref = await this.runtime.startPackage({
          package: spec,
          repoPath,
          idempotencyKey: key,
          dependencyCommits,
        });
        this.record(goalId, 'package-started', { packageId: spec.id, ref });
        return ref;
      }),
    );
    const failed = results.find(item => item.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return results.map(item => (item as PromiseFulfilledResult<PackageRuntimeRef>).value);
  }

  async reconcile(goalId: string): Promise<{ packageId: string; state: 'recovered' | 'unknown' }[]> {
    const state = this.store.getGoal(goalId);
    if (!state?.proposal || state.proposal.mode !== 'multi-wp') throw new Error('Multi-WP Goal required');
    const results: { packageId: string; state: 'recovered' | 'unknown' }[] = [];
    for (const [packageId, item] of Object.entries(state.packages ?? {})) {
      if (!['dispatching', 'resuming'].includes(item.status) || !item.dispatchIntent) continue;
      const ref = await this.runtime.recoverPackage?.(item.dispatchIntent, item.runtimeRef?.runId);
      if (ref) {
        this.record(goalId, item.status === 'resuming' ? 'package-resumed' : 'package-started', { packageId, ref });
        results.push({ packageId, state: 'recovered' });
      } else results.push({ packageId, state: 'unknown' });
    }
    return results;
  }
}

/** Recover notification if a process stopped between a Lead escalation and its inbox event. */
export function reconcileFailureEscalations(store: GoalRepository, goalId: string): void {
  const events = store.events(goalId);
  const notified = new Set(
    events
      .filter(event => event.type === 'human-notified')
      .map(event => (event.data as { decisionId?: string }).decisionId),
  );
  for (const event of events.filter(event => event.type === 'package-failure-decided')) {
    const data = event.data as { packageId: string; decision: string; reason: string };
    if (data.decision === 'escalate' && !notified.has(event.id))
      store.append(
        newEvent(goalId, 'human-notified', {
          kind: 'needs-decision',
          goalId,
          packageId: data.packageId,
          decisionId: event.id,
          note: data.reason,
        }),
      );
  }
}
