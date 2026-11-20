import { randomUUID } from 'node:crypto';
import { newEvent } from './events.js';
import { attemptLimit, type GoalEventType, type GoalState } from '../domain/transitions.js';
import { OrcaRefused } from '../runtime/orca/exec.js';
import { VerificationService, type VerificationResult } from './verification.js';
import { clockStart, currentLeadRef } from './lead.js';
import type { Budget, RuntimeRef } from '../domain/runtime-refs.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { RuntimeAdapter } from '../ports/runtime.js';
import { InvariantError, UserError } from '../domain/errors.js';

export class SoloService {
  constructor(
    private readonly store: GoalRepository,
    private readonly runtime: RuntimeAdapter,
  ) {}

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append(newEvent(goalId, type, data));
  }

  /** What the approved appetite leaves after `attempt` starts; the owner sees it in its brief. */
  private budget(state: GoalState, attempt: number): Budget | undefined {
    if (!state.appetite) return undefined;
    const started = clockStart(this.store.events(state.spec.id));
    const used = started ? (Date.now() - Date.parse(started)) / 60_000 : 0;
    return {
      minutesLeft: state.appetite.maxWallMinutes - used,
      attemptsLeft: Math.max(0, attemptLimit(state) - attempt),
    };
  }

  /**
   * Solo has no dispatch of its own: the owner is the Lead that planned, in the worktree and terminal it already
   * has. Recording that is idempotent; a Goal without an APOS-dispatched Lead is refused, never given a cold owner.
   */
  async adopt(goalId: string): Promise<RuntimeRef> {
    const state = this.store.getGoal(goalId);
    if (!state || !state.proposal || !state.proposal.mode.startsWith('solo'))
      throw new Error('Approved Solo proposal required');
    if (state.status === 'executing' && state.runtimeRef) return state.runtimeRef;
    if (state.status !== 'ready') throw new Error('Goal is not ready to dispatch');
    if (state.leadBot) return this.dispatchOwner(state);
    if (!state.lead || state.lead.settled)
      throw new Error(
        `No running APOS-dispatched Lead owns ${goalId}: the Human runs \`apos lead start ${goalId}\` and that Lead proposes and commits again`,
      );
    const ref = currentLeadRef(state.lead);
    this.record(goalId, 'execution-started', ref);
    return ref;
  }

  /**
   * A bot Lead plans and checks but never writes code: its Solo plan gets one owner, started on the Lead's worktree
   * (cut from the proposal's base commit) with the Solo owner brief. Intent first; a start whose outcome is unknown is
   * recovered by its key on the next call, never started twice.
   */
  private async dispatchOwner(state: GoalState): Promise<RuntimeRef> {
    const goalId = state.spec.id;
    const lead = state.lead;
    if (!lead) throw new InvariantError(`${goalId} has a bot Lead but no Lead worktree for its Solo owner`);
    if (!this.runtime.handoff) throw new UserError('Configured runtime cannot start a Solo owner');
    if (state.dispatchIntent) {
      const recovered = await this.runtime.recover?.(state.dispatchIntent, lead.ref.runId);
      if (!recovered) throw new UserError('Solo owner dispatch outcome unknown; reconcile Orca before retrying');
      const ref = { ...recovered, owner: 'lead' as const, worktreeId: recovered.worktreeId ?? lead.ref.worktreeId };
      this.record(goalId, 'execution-started', { ...ref, baseCommit: ref.baseCommit ?? lead.ref.baseCommit });
      return ref;
    }
    const key = randomUUID();
    this.record(goalId, 'dispatch-intended', key);
    let ref: RuntimeRef;
    try {
      ref = await this.runtime.handoff({
        kind: 'solo-owner',
        role: 'lead',
        repoPath: lead.ref.repoPath,
        goalId,
        goalVersion: state.spec.version,
        runId: lead.ref.runId,
        worktreeId: lead.ref.worktreeId,
        baseCommit: lead.ref.baseCommit,
        idempotencyKey: key,
        attempt: 1,
        budget: this.budget(state, 1),
        extra: `This Goal's Lead is the Orca bot ${state.leadBot!.name}; it planned and it checks, and you are the only one who writes the code.`,
      });
    } catch (error) {
      if (error instanceof OrcaRefused)
        this.record(goalId, 'intent-abandoned', { key, reason: `Orca refused: ${error.code}` });
      throw error;
    }
    const owner = { ...ref, owner: 'lead' as const };
    this.record(goalId, 'execution-started', owner);
    return owner;
  }

  async resume(goalId: string): Promise<RuntimeRef> {
    const state = this.store.getGoal(goalId);
    if (
      !state ||
      state.status !== 'executing' ||
      !state.proposal?.mode.startsWith('solo') ||
      !state.runtimeRef ||
      !state.checkpoint
    )
      throw new Error('Solo checkpoint and active owner required');
    if (state.resumeIntent) {
      const recovered = await this.runtime.recover?.(state.resumeIntent, state.runtimeRef!.runId);
      if (!recovered) throw new Error('Resume outcome unknown; reconcile Orca before retrying');
      this.record(goalId, 'runtime-resumed', recovered);
      return recovered;
    }
    if ((state.soloAttempts ?? 1) >= attemptLimit(state)) {
      this.record(goalId, 'blocked', { kind: 'technical', note: 'Retry budget exhausted' });
      throw new Error('Solo retry budget exhausted; Lead decision required');
    }
    const observation = await this.runtime.inspect(state.runtimeRef);
    if (!['completed', 'failed'].includes(observation.outcome ?? ''))
      throw new Error('Prior Orca dispatch must settle before Solo resume');
    const key = randomUUID();
    this.record(goalId, 'resume-intended', key);
    let next: RuntimeRef;
    try {
      next = await this.runtime.resumeSolo(
        state.runtimeRef,
        state.checkpoint,
        key,
        this.budget(state, state.checkpoint.attempt ?? (state.soloAttempts ?? 1) + 1),
      );
    } catch (error) {
      if (error instanceof OrcaRefused)
        this.record(goalId, 'intent-abandoned', { key, reason: `Orca refused: ${error.code}` });
      throw error;
    }
    this.record(goalId, 'runtime-resumed', next);
    return next;
  }

  async reconcile(goalId: string): Promise<'live' | 'settled' | 'unverifiable'> {
    const state = this.store.getGoal(goalId);
    if (!state?.runtimeRef) return 'unverifiable';
    let ref = state.runtimeRef;
    if (state.resumeIntent) {
      const recovered = await this.runtime.recover?.(state.resumeIntent, ref.runId);
      if (!recovered) return 'unverifiable';
      this.record(goalId, 'runtime-resumed', recovered);
      ref = recovered;
    }
    const observation = await this.runtime.inspect(ref);
    return observation.state;
  }

  async verify(goalId: string, deliveryCommit?: string): Promise<VerificationResult> {
    const state = this.store.getGoal(goalId);
    if (state?.status !== 'executing' || !state.proposal?.mode.startsWith('solo') || !state.runtimeRef)
      throw new Error('Executing Solo Goal required');
    const observation = await this.runtime.inspect(state.runtimeRef);
    if (observation.outcome !== 'completed')
      throw new Error('Orca Solo dispatch must complete successfully before verification');
    return new VerificationService(this.store).verify(goalId, deliveryCommit);
  }
}
