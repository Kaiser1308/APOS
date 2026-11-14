import { randomUUID } from 'node:crypto';
import { attemptLimit, type GoalEventType, type GoalState, type HandoffTarget } from '../domain/transitions.js';
import { reviewReasons } from '../domain/reviews.js';
import type { GoalRepository } from '../store/journal.js';
import type { HandoffInput, RuntimeAdapter } from '../runtime/orca.js';
import { handoffRole, type Budget, type HandoffKind, type Role, type RuntimeProfile, type RuntimeProfiles } from '../runtime/brief.js';
import type { PackageRuntime, PackageRuntimeRef } from './packages.js';
import { clockStart } from './lead.js';

/** Blocks a handoff may clear: the ones the controller records when the very dispatch being replaced settles failed. */
const FAILED_SETTLEMENT = [/^needs-decision: owner reported failed on attempt/, /^Worker reported failed on/];
const causedByFailure = (note: unknown) => typeof note === 'string' && FAILED_SETTLEMENT.some(pattern => pattern.test(note));

type Plan = { from: string; role: Role; runId: string; requested?: { agent?: string; model?: string }; unblock: boolean; start: (key: string) => Promise<Record<string, unknown> & { dispatchId: string }> };

/**
 * Moves the owner of a dispatch to a fresh agent on the same worktree, for example when its agent ran out of quota.
 * Intent first; the old agent is stopped and confirmed stopped before the new one starts, so two agents never work
 * the same worktree. It is the same owner continuing: no attempt is spent.
 */
export class HandoffService {
  constructor(private readonly store: GoalRepository, private readonly runtime: RuntimeAdapter & Partial<PackageRuntime>, private readonly profiles: () => RuntimeProfiles) {}

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append({ id: randomUUID(), goalId, type, data, at: new Date().toISOString() });
  }

  private budget(state: GoalState, attempt: number): Budget | undefined {
    if (!state.appetite) return undefined;
    const started = clockStart(this.store.events(state.spec.id));
    const used = started ? (Date.now() - Date.parse(started)) / 60_000 : 0;
    return { minutesLeft: state.appetite.maxWallMinutes - used, attemptsLeft: Math.max(0, attemptLimit(state) - attempt) };
  }

  async handoff(goalId: string, target: HandoffTarget, repoPath: string): Promise<{ dispatchId: string; warning?: string }> {
    const state = this.store.getGoal(goalId);
    if (!state) throw new Error(`Goal does not exist: ${goalId}`);
    if (state.handoffIntent) throw new Error(`A handoff of ${goalId} is already pending (key ${state.handoffIntent.key}); check Orca, then \`apos execution abandon-intent ${goalId} --key ${state.handoffIntent.key} --reason ...\` if nothing started`);
    const blocked = state.status === 'blocked';
    if (blocked && !causedByFailure((state.blocker as { note?: unknown } | undefined)?.note)) throw new Error(`${goalId} is blocked for another reason: ${(state.blocker as { note?: string } | undefined)?.note ?? 'unknown'}`);
    const plan = this.plan(state, target, repoPath, blocked);

    const key = randomUUID();
    this.record(goalId, 'handoff-intended', { key, target, from: plan.from });
    const observation = await this.runtime.inspect({ runId: plan.runId, taskId: '', dispatchId: plan.from, owner: 'lead', repoPath }).catch(() => undefined);
    if (!observation?.outcome) {
      const stopped = this.runtime.stopWorker ? await this.runtime.stopWorker(plan.from) : 'unknown';
      if (stopped !== 'stopped') {
        this.record(goalId, 'intent-abandoned', { key, reason: 'Orca could not confirm the old agent stopped' });
        throw new Error(`Could not confirm the old agent stopped; check Orca (orca orchestration worker-show --dispatch ${plan.from}) before retrying`);
      }
    }
    let ref: Record<string, unknown> & { dispatchId: string };
    try { ref = await plan.start(key); }
    catch (error) {
      this.record(goalId, 'intent-abandoned', { key, reason: `new agent did not start: ${error instanceof Error ? error.message : String(error)}` });
      throw new Error(`The old agent is stopped but the new one did not start (${error instanceof Error ? error.message : String(error)}). Run apos handoff again.`);
    }
    this.record(goalId, 'owner-handed-off', { key, target, from: plan.from, ref, ...(plan.unblock ? { unblock: true } : {}) });
    const wanted: RuntimeProfile = this.profiles()[plan.role];
    const same = plan.requested?.agent === wanted.agent && (plan.requested?.model ?? undefined) === (wanted.model ?? undefined);
    return { dispatchId: ref.dispatchId, ...(same ? { warning: 'same agent and model as before: the new agent may run out of quota too' } : {}) };
  }

  private plan(state: GoalState, target: HandoffTarget, repoPath: string, blocked: boolean): Plan {
    const goalId = state.spec.id;
    const handoff = this.runtime.handoff?.bind(this.runtime);
    if (!handoff) throw new Error('Configured runtime cannot hand work to another agent');
    const common = { repoPath, goalId, goalVersion: state.spec.version };

    if (target.kind === 'reviewer') {
      const review = state.reviewDispatch;
      if (!review) throw new Error(`${goalId} has no reviewer running`);
      if (!this.runtime.startReviewer) throw new Error('Configured runtime cannot start a reviewer');
      const baseCommit = state.proposal?.baseCommit ?? state.lead?.ref.baseCommit;
      if (!baseCommit) throw new Error(`${goalId} has no base commit for a reviewer`);
      return {
        from: review.dispatchId, role: 'reviewer', runId: review.runId, requested: review.requested, unblock: false,
        start: async key => {
          const reviewer = await this.runtime.startReviewer!({ repoPath, goalId, baseCommit, commit: review.commit, reasons: reviewReasons(state), idempotencyKey: key, runId: review.runId });
          return { dispatchId: reviewer.dispatchId, runId: reviewer.runId, key, commit: review.commit, worktreeId: reviewer.worktreeId, terminal: reviewer.terminal, requested: reviewer.requested };
        }
      };
    }

    if (target.kind === 'package') {
      const item = state.packages?.[target.packageId];
      if (!item) throw new Error(`${goalId} has no package ${target.packageId}`);
      const ref = item.runtimeRef as PackageRuntimeRef | undefined;
      const packageBlocked = item.status === 'blocked';
      if (packageBlocked && !causedByFailure(item.blocker?.note)) throw new Error(`${target.packageId} is blocked for another reason: ${item.blocker?.note}`);
      if (!ref || !['executing', 'blocked'].includes(item.status)) throw new Error(`${target.packageId} has no Worker running (status ${item.status})`);
      if (!ref.worktreeId || !ref.baseCommit) throw new Error(`${target.packageId} Worker has no recorded worktree or base commit`);
      const input: HandoffInput = { ...common, kind: 'worker', role: 'worker', runId: ref.runId, worktreeId: ref.worktreeId, baseCommit: ref.baseCommit, idempotencyKey: '', attempt: Math.max(1, item.attempts), fromAgent: ref.requested?.agent, packageId: item.spec.id, packageVersion: item.spec.version, owner: item.spec.owner, outcome: item.spec.outcome };
      return { from: ref.dispatchId, role: 'worker', runId: ref.runId, requested: ref.requested, unblock: blocked || packageBlocked, start: async key => ({ ...await handoff({ ...input, idempotencyKey: key }), owner: 'worker' }) };
    }

    const lead = state.lead;
    if (!lead) throw new Error(`No APOS-dispatched Lead for ${goalId}: run \`apos lead start ${goalId}\` instead`);
    const solo = state.proposal?.mode.startsWith('solo') && ['executing', 'blocked'].includes(state.status) && state.runtimeRef;
    const kind: HandoffKind = solo ? 'solo-owner' : ['executing', 'blocked'].includes(state.status) ? 'lead-multi' : 'lead-plan';
    const current = solo ? state.runtimeRef as { dispatchId: string; runId: string; requested?: { agent?: string; model?: string } } : { dispatchId: lead.current, runId: lead.ref.runId, requested: lead.ref.requested as { agent?: string; model?: string } | undefined };
    const attempt = kind === 'solo-owner' ? state.soloAttempts ?? 1 : 1;
    const input: HandoffInput = { ...common, kind, role: handoffRole(kind), runId: current.runId, worktreeId: lead.ref.worktreeId, baseCommit: lead.ref.baseCommit, idempotencyKey: '', attempt, fromAgent: current.requested?.agent, budget: kind === 'lead-multi' ? undefined : this.budget(state, attempt) };
    return { from: current.dispatchId, role: 'lead', runId: current.runId, requested: current.requested, unblock: blocked, start: async key => handoff({ ...input, idempotencyKey: key }) };
  }
}
