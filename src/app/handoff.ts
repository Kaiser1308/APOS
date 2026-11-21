import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { newEvent } from './events.js';
import { attemptLimit, type GoalEventType, type GoalState, type HandoffTarget } from '../domain/transitions.js';
import { reviewReasons } from '../domain/reviews.js';
import { OrcaRefused } from '../runtime/orca/exec.js';
import { handoffRole, packageReportPath } from '../runtime/brief.js';
import { clockStart } from './lead.js';
import { writeLeadLog } from './lead-log.js';
import { multiWallTimeExpired } from './multi-budget.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { HandoffInput, PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import { UserError } from '../domain/errors.js';
import type {
  Budget,
  HandoffKind,
  PackageRuntimeRef,
  Role,
  RuntimeProfile,
  RuntimeProfiles,
  RuntimeRef,
} from '../domain/runtime-refs.js';

/** Blocks a handoff may clear: the ones the controller records when the very dispatch being replaced settles failed. */
const FAILED_SETTLEMENT = [/^needs-decision: owner reported failed on attempt/, /^Worker reported failed on/];
export const causedByFailure = (note: unknown): boolean =>
  typeof note === 'string' && FAILED_SETTLEMENT.some(pattern => pattern.test(note));
const committed = (repo: string, commit: string, path: string): boolean => {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${commit}:${path}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

type Started = Record<string, unknown> & { dispatchId: string };
type Plan = {
  from: string;
  role: Role;
  runId: string;
  requested?: { agent?: string; model?: string };
  unblock: boolean;
  start: (key: string) => Promise<Started>;
  /** Looks up a start whose response was lost, by its key, shaped as the ref `owner-handed-off` records. */
  recover: (key: string) => Promise<Started | undefined>;
};

/**
 * Moves the owner of a dispatch to a fresh agent on the same worktree, for example when its agent ran out of quota.
 * Intent first; the old agent is stopped and confirmed stopped before the new one starts, so two agents never work the
 * same worktree. A start whose outcome is unknown keeps the intent and is recovered by its key on the next run; the
 * intent is dropped only while the old agent may still be running. It is the same owner continuing: no attempt is spent.
 */
export class HandoffService {
  constructor(
    private readonly store: GoalRepository,
    private readonly runtime: RuntimeAdapter & Partial<PackageRuntime>,
    private readonly profiles: () => RuntimeProfiles,
  ) {}

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append(newEvent(goalId, type, data));
  }

  private budget(state: GoalState, attempt: number): Budget | undefined {
    if (!state.appetite) return undefined;
    const started = clockStart(this.store.events(state.spec.id));
    const used = started ? (Date.now() - Date.parse(started)) / 60_000 : 0;
    return {
      minutesLeft: state.appetite.maxWallMinutes - used,
      attemptsLeft: Math.max(0, attemptLimit(state) - attempt),
    };
  }

  async handoff(
    goalId: string,
    target: HandoffTarget,
    repoPath: string,
  ): Promise<{ dispatchId: string; warning?: string }> {
    const state = this.store.getGoal(goalId);
    if (!state) throw new Error(`Goal does not exist: ${goalId}`);
    if (state.handoffIntent?.target.kind === 'bot')
      throw new UserError(
        `The transfer of ${goalId}'s Lead to bot ${state.handoffIntent.target.botName} is pending; finish it with \`apos handoff ${goalId} --to-bot ${state.handoffIntent.target.botId}\``,
      );
    if (
      target.kind === 'lead' &&
      state.leadBot &&
      !(state.proposal?.mode.startsWith('solo') && ['executing', 'blocked'].includes(state.status) && state.runtimeRef)
    )
      throw new UserError(
        `The Lead of ${goalId} is bot ${state.leadBot.name}; run \`apos handoff ${goalId} --to-apos\` to give it to a fresh APOS Lead`,
      );
    if ((target.kind === 'lead' || state.handoffIntent?.target.kind === 'lead') && state.proposal?.mode === 'multi-wp')
      writeLeadLog(this.store, goalId, state.lead?.ref.worktreeId);
    const pending = state.handoffIntent;
    if (pending) return this.resumePending(state, pending, repoPath);
    if (multiWallTimeExpired(this.store, goalId))
      throw new UserError('Multi-WP wall time exhausted; Human decision required before handoff');

    const busy = state.resumeIntent
      ? 'resume'
      : state.leadIntent
        ? 'Lead dispatch'
        : state.reviewIntent
          ? 'reviewer start'
          : state.status === 'ready' && state.dispatchIntent
            ? 'dispatch'
            : undefined;
    if (busy) throw new Error(`A ${busy} of ${goalId} is pending; wait until the controller settles it, then hand off`);
    const blocked = state.status === 'blocked';
    if (blocked && !causedByFailure(state.blocker?.note))
      throw new Error(`${goalId} is blocked for another reason: ${state.blocker?.note ?? 'unknown'}`);
    const plan = await this.plan(state, target, repoPath, blocked);

    const key = randomUUID();
    this.record(goalId, 'handoff-intended', {
      key,
      target,
      from: plan.from,
      runId: plan.runId,
      ...(plan.unblock ? { unblock: true } : {}),
    });
    if (!(await this.stopped(plan, repoPath))) {
      // Nothing was started and the old agent may still run: back to normal supervision.
      this.record(goalId, 'intent-abandoned', { key, reason: 'Orca could not confirm the old agent stopped' });
      throw new Error(
        `Could not confirm the old agent stopped; check Orca (orca orchestration worker-show --dispatch ${plan.from}) before retrying`,
      );
    }
    return this.start(goalId, plan, key, target);
  }

  /** A handoff left pending by a lost response or a refusal: recover what started under its key, else start under it. */
  private async resumePending(
    state: GoalState,
    pending: NonNullable<GoalState['handoffIntent']>,
    repoPath: string,
  ): Promise<{ dispatchId: string; warning?: string }> {
    const goalId = state.spec.id;
    const plan = await this.plan(state, pending.target, repoPath, Boolean(pending.unblock), true);
    const found = await plan.recover(pending.key).catch(() => undefined);
    if (found) {
      this.record(goalId, 'owner-handed-off', {
        key: pending.key,
        target: pending.target,
        from: pending.from,
        ref: found,
        ...(pending.unblock ? { unblock: true } : {}),
      });
      return { dispatchId: found.dispatchId };
    }
    if (multiWallTimeExpired(this.store, goalId))
      throw new UserError('Multi-WP wall time exhausted; Human decision required before handoff');
    if (!(await this.stopped(plan, repoPath)))
      throw new Error(
        `The handoff of ${goalId} is pending and Orca cannot confirm the old agent stopped; check Orca (orca orchestration worker-show --dispatch ${pending.from}), then \`apos execution abandon-intent ${goalId} --key ${pending.key} --reason ...\` if nothing started`,
      );
    return this.start(goalId, plan, pending.key, pending.target);
  }

  /** True when the old dispatch has settled or Orca confirms it stopped it. */
  private async stopped(plan: Plan, repoPath: string): Promise<boolean> {
    const observation = await this.runtime
      .inspect({ runId: plan.runId, taskId: '', dispatchId: plan.from, owner: 'lead', repoPath })
      .catch(() => undefined);
    if (observation?.outcome) return true;
    return (this.runtime.stopWorker ? await this.runtime.stopWorker(plan.from) : 'unknown') === 'stopped';
  }

  private async start(
    goalId: string,
    plan: Plan,
    key: string,
    target: HandoffTarget,
  ): Promise<{ dispatchId: string; warning?: string }> {
    let ref: Started;
    try {
      ref = await plan.start(key);
    } catch (error) {
      // The old agent is stopped, so the intent stays: the controller keeps leaving the stopped dispatch alone, and the
      // next `apos handoff` recovers a start that did happen, by its key, instead of starting a second agent.
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof OrcaRefused)
        throw new Error(
          `The old agent is stopped but Orca refused to start the new one (${detail}). Run apos handoff again.`,
        );
      throw new Error(
        `The old agent is stopped and the new agent's start outcome is unknown (${detail}). Run apos handoff again: it recovers the agent by key if it started, and starts it otherwise.`,
      );
    }
    this.record(goalId, 'owner-handed-off', {
      key,
      target,
      from: plan.from,
      ref,
      ...(plan.unblock ? { unblock: true } : {}),
    });
    const wanted: RuntimeProfile = this.profiles()[plan.role];
    const same =
      plan.requested?.agent === wanted.agent && (plan.requested?.model ?? undefined) === (wanted.model ?? undefined);
    return {
      dispatchId: ref.dispatchId,
      ...(same ? { warning: 'same agent and model as before: the new agent may run out of quota too' } : {}),
    };
  }

  private async plan(
    state: GoalState,
    target: HandoffTarget,
    repoPath: string,
    blocked: boolean,
    resuming = false,
  ): Promise<Plan> {
    const goalId = state.spec.id;
    const handoff = this.runtime.handoff?.bind(this.runtime);
    if (!handoff) throw new Error('Configured runtime cannot hand work to another agent');
    const common = { repoPath, goalId, goalVersion: state.spec.version };
    const withProfile = (role: Role, found: RuntimeRef | PackageRuntimeRef | undefined) =>
      found ? { ...found, requested: found.requested ?? this.profiles()[role] } : undefined;

    if (target.kind === 'reviewer') {
      const review = state.reviewDispatch;
      if (!review) throw new Error(`${goalId} has no reviewer running`);
      if (!this.runtime.startReviewer) throw new Error('Configured runtime cannot start a reviewer');
      const baseCommit = state.proposal?.baseCommit ?? state.lead?.ref.baseCommit;
      if (!baseCommit) throw new Error(`${goalId} has no base commit for a reviewer`);
      const shape = (
        found: {
          dispatchId: string;
          runId: string;
          worktreeId?: string;
          terminal?: string;
          requested?: RuntimeProfile;
        },
        key: string,
      ): Started => ({
        dispatchId: found.dispatchId,
        runId: found.runId,
        key,
        commit: review.commit,
        worktreeId: found.worktreeId,
        terminal: found.terminal,
        requested: found.requested ?? this.profiles().reviewer,
      });
      return {
        from: review.dispatchId,
        role: 'reviewer',
        runId: review.runId,
        requested: review.requested,
        unblock: false,
        start: async key =>
          shape(
            await this.runtime.startReviewer!({
              repoPath,
              goalId,
              baseCommit,
              commit: review.commit,
              reasons: reviewReasons(state),
              idempotencyKey: key,
              runId: review.runId,
            }),
            key,
          ),
        recover: async key => {
          const found = await this.runtime.recover?.(key, review.runId);
          return found ? shape(found, key) : undefined;
        },
      };
    }

    if (target.kind === 'package') {
      const item = state.packages?.[target.packageId];
      if (!item) throw new Error(`${goalId} has no package ${target.packageId}`);
      const ref = item.runtimeRef;
      if (['dispatching', 'resuming'].includes(item.status))
        throw new Error(
          `A dispatch of ${target.packageId} is pending; wait until the controller settles it, then hand off`,
        );
      const packageBlocked = item.status === 'blocked';
      if (packageBlocked && !causedByFailure(item.blocker?.note))
        throw new Error(`${target.packageId} is blocked for another reason: ${item.blocker?.note}`);
      if (!ref || !['executing', 'blocked'].includes(item.status))
        throw new Error(`${target.packageId} has no Worker running (status ${item.status})`);
      if (!ref.worktreeId || !ref.baseCommit)
        throw new Error(`${target.packageId} Worker has no recorded worktree or base commit`);
      if (packageBlocked && !resuming) {
        // A Worker that reported failed with a report said what blocks it: that is the Lead's decision, not a quota problem.
        const head = await this.runtime.deliveryHead?.(ref).catch(() => undefined);
        if (
          head &&
          committed(
            repoPath,
            head,
            packageReportPath(goalId, item.spec.id, item.spec.version, Math.max(1, item.attempts)),
          )
        )
          throw new Error(
            `${target.packageId}'s Worker reported failed with a delivery report: the Lead decides (revise or unblock the package), not a handoff`,
          );
      }
      const dependencyCommits = item.spec.dependencies
        .map(dep => {
          const dependency = state.packages?.[dep];
          return dependency?.gate?.deliveryCommit ?? dependency?.evidence.at(-1)?.commitRef;
        })
        .filter((commit): commit is string => Boolean(commit));
      const input: HandoffInput = {
        ...common,
        kind: 'worker',
        role: 'worker',
        runId: ref.runId,
        worktreeId: ref.worktreeId,
        baseCommit: ref.baseCommit,
        idempotencyKey: '',
        attempt: Math.max(1, item.attempts),
        fromAgent: ref.requested?.agent,
        packageId: item.spec.id,
        packageVersion: item.spec.version,
        owner: item.spec.owner,
        outcome: item.spec.outcome,
        packageContract: item.spec,
        ...(dependencyCommits.length
          ? { extra: `Integrate these verified dependency commits before delivery: ${dependencyCommits.join(', ')}.` }
          : {}),
      };
      return {
        from: ref.dispatchId,
        role: 'worker',
        runId: ref.runId,
        requested: ref.requested,
        unblock: blocked || packageBlocked,
        start: async key => ({ ...(await handoff({ ...input, idempotencyKey: key })), owner: 'worker' }),
        recover: async key => {
          const found = withProfile('worker', await this.runtime.recoverPackage?.(key, ref.runId));
          return found
            ? {
                ...found,
                owner: 'worker',
                worktreeId: found.worktreeId ?? ref.worktreeId,
                baseCommit: found.baseCommit ?? ref.baseCommit,
              }
            : undefined;
        },
      };
    }

    const lead = state.lead;
    if (!lead) throw new Error(`No APOS-dispatched Lead for ${goalId}: run \`apos lead start ${goalId}\` instead`);
    const solo =
      state.proposal?.mode.startsWith('solo') && ['executing', 'blocked'].includes(state.status) && state.runtimeRef;
    const kind: HandoffKind = solo
      ? 'solo-owner'
      : ['executing', 'blocked'].includes(state.status)
        ? 'lead-multi'
        : 'lead-plan';
    const current = solo
      ? state.runtimeRef!
      : {
          dispatchId: lead.current,
          runId: lead.ref.runId,
          requested: lead.ref.requested,
        };
    const attempt = kind === 'solo-owner' ? (state.soloAttempts ?? 1) : 1;
    const input: HandoffInput = {
      ...common,
      kind,
      role: handoffRole(kind),
      runId: current.runId,
      worktreeId: lead.ref.worktreeId,
      baseCommit: lead.ref.baseCommit,
      idempotencyKey: '',
      attempt,
      fromAgent: current.requested?.agent,
      budget: kind === 'lead-multi' ? undefined : this.budget(state, attempt),
    };
    return {
      from: current.dispatchId,
      role: 'lead',
      runId: current.runId,
      requested: current.requested,
      unblock: blocked,
      start: async key => handoff({ ...input, idempotencyKey: key }),
      recover: async key => {
        const found = withProfile('lead', await this.runtime.recover?.(key, current.runId));
        return found
          ? {
              ...found,
              worktreeId: found.worktreeId ?? lead.ref.worktreeId,
              baseCommit: found.baseCommit ?? lead.ref.baseCommit,
            }
          : undefined;
      },
    };
  }
}
