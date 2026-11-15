import {
  dispatchReviewer,
  readReviewResult,
  recordTelemetry,
  show,
  watchAndUnstick,
  foreignCommits,
  remaining,
  describe,
} from './supervision.js';
import { newEvent } from './events.js';
import { clockStart } from './lead.js';
import type { GoalEventType, GoalState } from '../domain/transitions.js';
import { attemptLimit, handingOff } from '../domain/transitions.js';
import { reviewReasons } from '../domain/reviews.js';
import { CORE_SKILL, activationLine, committedFileDigest, reviewResultPath, soloReportPath } from '../runtime/brief.js';
import { GateService } from './gate.js';
import { SoloService } from './solo.js';
import { VerificationService } from './verification.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { RuntimeAdapter } from '../ports/runtime.js';
import type { RuntimeRef } from '../domain/runtime-refs.js';
import type { TelemetryProbe } from '../ports/telemetry.js';
import type { CommitInspector } from '../ports/commit-inspector.js';

export type SupervisorOptions = {
  gate?: GateService;
  telemetry?: TelemetryProbe;
  now?: () => number;
  inspector?: CommitInspector;
  /** Moves the Lead to a fresh agent on its worktree (the handoff), for a wake whose session has ended. */ freshLead?: (
    goalId: string,
    repoPath: string,
  ) => Promise<unknown>;
};

/**
 * The controller's mechanical loop for a Solo Goal after its owner settles:
 * receipt → delivery head → activation → gate → review or verify, and on red a machine finding that
 * resumes the same owner. It stops at `needs-decision` (a blocked Goal) when the cause is unknown,
 * the same failure survives two repairs, the budget or wall time is spent, or the runtime is wrong.
 * No LLM waits; each call does at most one step per Goal.
 */
export class SoloSupervisor {
  private readonly gate: GateService;
  private readonly now: () => number;
  constructor(
    private readonly store: GoalRepository,
    private readonly runtime: RuntimeAdapter,
    private readonly options: SupervisorOptions = {},
  ) {
    this.gate = options.gate ?? new GateService(store);
    this.now = options.now ?? Date.now;
  }

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append(newEvent(goalId, type, data, new Date(this.now()).toISOString()));
  }

  private decide(goalId: string, note: string, actions: string[]): void {
    this.record(goalId, 'blocked', { kind: 'technical', note: `needs-decision: ${note}` });
    this.record(goalId, 'human-notified', { kind: 'needs-decision', goalId, note });
    actions.push(`needs-decision: ${note}`);
  }

  private wallMinutesUsed(goalId: string): number {
    const started = clockStart(this.store.events(goalId));
    return started ? (this.now() - Date.parse(started)) / 60_000 : 0;
  }

  async step(goalId: string, repoPath: string): Promise<string[]> {
    const actions: string[] = [];
    const state = this.store.getGoal(goalId);
    if (
      !state ||
      state.status !== 'executing' ||
      !state.proposal?.mode.startsWith('solo') ||
      !state.runtimeRef ||
      handingOff(state)
    )
      return actions;
    const ref = state.runtimeRef;
    const overTime = state.appetite && this.wallMinutesUsed(goalId) > state.appetite.maxWallMinutes;
    const outcome = state.settlements?.[ref.dispatchId];
    if (!outcome) {
      const noticed = this.store
        .events(goalId)
        .some(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'overrun');
      if (overTime && !noticed) {
        this.record(goalId, 'human-notified', {
          kind: 'overrun',
          goalId,
          note: 'owner still running past the approved wall time',
        });
        actions.push('notified overrun');
      }
      const since = [...this.store.events(goalId)]
        .reverse()
        .find(item => ['execution-started', 'runtime-resumed'].includes(item.type));
      // Seen live: an owner's turn died at launch (`model_not_found`) and Orca kept it `live idle` with nothing in the inbox.
      actions.push(
        ...(await watchAndUnstick(
          this.store,
          this.runtime,
          this.now,
          {
            goalId,
            dispatchId: ref.dispatchId,
            runId: ref.runId,
            repoPath: ref.repoPath,
            terminal: ref.terminal,
            role: 'lead',
            requested: ref.requested,
            handoffHint: `apos handoff ${goalId} --agent <other>`,
          },
          since?.at,
        )),
      );
      return actions;
    }
    if (state.reviewDispatch) return this.collectReview(state, repoPath, actions);
    const attempt = state.soloAttempts ?? 1;
    if ((state.findings ?? []).some(item => item.attempt === attempt && item.by === 'controller')) {
      // A repair the controller already decided on but Orca refused to start: retry, bounded.
      if (state.checkpoint && !state.resumeIntent) {
        const refusals = this.store.events(goalId).filter(item => item.type === 'intent-abandoned').length;
        if (refusals >= 3) {
          this.decide(goalId, `Orca refused to resume the owner ${refusals} times`, actions);
          return actions;
        }
        try {
          actions.push(`resumed owner: ${(await new SoloService(this.store, this.runtime).resume(goalId)).dispatchId}`);
        } catch (error) {
          actions.push(`resume refused, will retry: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return actions;
    }

    // After the repair check: a review that asks for changes leaves a green gate behind (seen live).
    if (state.gate?.attemptKey && state.gate.result === 'green') {
      if (state.reviewIntent && state.status === 'executing') return this.recoverReview(state, ref, repoPath, actions);
      return actions;
    }

    await recordTelemetry(this.store, this.runtime, this.now, this.options.telemetry, state, ref, 'lead');
    if (outcome === 'failed') {
      // Seen live: an owner reported failed with most of the Goal built and 75 of 90 minutes left. While the
      // appetite lasts, an honest "not done" is a finding for the same owner, not a stop. repair() enforces the budget.
      const failedHead = await this.runtime.deliveryHead?.(ref);
      const failedReport = failedHead && show(repoPath, failedHead, soloReportPath(goalId, attempt));
      const failedLine = ref.baseCommit
        ? activationLine(committedFileDigest(repoPath, ref.baseCommit, CORE_SKILL))
        : undefined;
      if (!failedHead || !failedReport || !failedLine || !failedReport.includes(failedLine)) {
        this.decide(goalId, `owner reported failed on attempt ${attempt} without a delivery report`, actions);
        return actions;
      }
      return this.repair(
        state,
        {
          note: `You reported failed on attempt ${attempt} at ${failedHead}, and the approved budget is not spent. Your report says what remains: ${remaining(failedReport)} Finish it. Report failed again only if the Goal cannot be met within scope, naming the requirement that blocks it.`,
          signature: 'owner-incomplete',
          commit: failedHead,
        },
        repoPath,
        actions,
      );
    }
    const receipt = await this.runtime.launchReceipt?.(ref.dispatchId);
    if (ref.requested?.model && receipt?.model && receipt.model !== ref.requested.model) {
      this.decide(
        goalId,
        `runtime launched ${receipt.agent}/${receipt.model}, plan requires ${ref.requested.agent}/${ref.requested.model}`,
        actions,
      );
      return actions;
    }
    const head = await this.runtime.deliveryHead?.(ref);
    if (!head || !ref.baseCommit) {
      this.decide(goalId, 'delivery commit unknown: owner worktree or base commit missing', actions);
      return actions;
    }
    // Seen live: an owner told the repo path committed into the managed checkout instead of its worktree.
    const intruders = foreignCommits(repoPath, ref.baseCommit, goalId);
    if (intruders.length) {
      this.decide(
        goalId,
        `the owner's delivery landed in the managed checkout instead of its worktree: ${intruders.join(', ')}`,
        actions,
      );
      return actions;
    }

    const report = show(repoPath, head, soloReportPath(goalId, attempt));
    const line = activationLine(committedFileDigest(repoPath, ref.baseCommit, CORE_SKILL));
    if (!report || !report.includes(line)) {
      return this.repair(
        state,
        {
          note: report
            ? `Delivery report lacks the activation line "${line}": the core execution skill was not loaded as briefed.`
            : `No delivery report committed at ${soloReportPath(goalId, attempt)} on ${head}.`,
          signature: report ? 'activation' : 'no-report',
          commit: head,
        },
        repoPath,
        actions,
      );
    }

    const gate = this.gate.run(goalId, repoPath, { deliveryCommit: head });
    actions.push(`gate ${gate.result} on ${head}`);
    if (gate.result === 'green') {
      const reasons = reviewReasons(this.store.getGoal(goalId)!);
      if (reasons.length && this.runtime.startReviewer)
        return this.startReview(goalId, ref, head, repoPath, reasons, actions);
      if (reasons.length) {
        this.decide(goalId, `review required (${reasons.join('; ')}) but no reviewer runtime`, actions);
        return actions;
      }
      new VerificationService(this.store).verify(goalId, head);
      this.record(goalId, 'human-notified', { kind: 'awaiting-outcome', goalId, deliveryCommit: head });
      actions.push('verified; awaiting Human outcome');
      return actions;
    }
    if (gate.result === 'pending') {
      this.record(goalId, 'human-notified', {
        kind: 'manual-check',
        goalId,
        deliveryCommit: head,
        checks: gate.checks.filter(item => item.status === 'manual-pending').map(item => item.checkId),
      });
      actions.push('awaiting manual check');
      return actions;
    }
    if (gate.result === 'unverifiable') {
      this.decide(goalId, `gate unverifiable on ${head}: ${describe(gate)}`, actions);
      return actions;
    }
    const failing = gate.checks.filter(item => item.status === 'fail');
    return this.repair(
      state,
      {
        note: `Controller gate red on ${head}: ${describe(gate)}`,
        signature: failing
          .map(item => `${item.checkId}[${item.newFailures.join(',')}]`)
          .sort()
          .join('|'),
        checkIds: failing.map(item => item.checkId),
        logRefs: failing.flatMap(item => item.delivery.map(run => run.logRef)),
        commit: head,
      },
      repoPath,
      actions,
    );
  }

  /** The intent is recorded first: seen live, Orca created the reviewer but reported its start as outcome-unknown. */
  private async startReview(
    goalId: string,
    ref: RuntimeRef,
    head: string,
    repoPath: string,
    reasons: string[],
    actions: string[],
  ): Promise<string[]> {
    actions.push(
      await dispatchReviewer(
        this.store,
        this.runtime,
        this.now,
        { goalId, repoPath, baseCommit: ref.baseCommit!, commit: head, reasons, runId: ref.runId },
        {
          started: dispatchId => `reviewer ${dispatchId}: ${reasons.join('; ')}`,
          unknown: 'reviewer start outcome unknown, will recover by key',
        },
      ),
    );
    return actions;
  }

  private async recoverReview(
    state: GoalState,
    ref: RuntimeRef,
    repoPath: string,
    actions: string[],
  ): Promise<string[]> {
    const goalId = state.spec.id;
    const intent = state.reviewIntent!;
    const found = await this.runtime.recover?.(intent.key, ref.runId);
    if (found) {
      this.record(goalId, 'review-dispatched', {
        dispatchId: found.dispatchId,
        runId: found.runId,
        key: intent.key,
        commit: intent.commit,
        worktreeId: found.worktreeId,
        terminal: found.terminal,
      });
      actions.push(`recovered reviewer ${found.dispatchId}`);
      return actions;
    }
    if (this.now() - Date.parse(intent.at) < 3 * 60_000) return actions;
    const tries = this.store.events(goalId).filter(item => item.type === 'review-intended').length;
    if (tries >= 3 || !this.runtime.startReviewer || !ref.baseCommit) {
      this.decide(goalId, `reviewer for ${intent.commit} could not be started or found after ${tries} tries`, actions);
      return actions;
    }
    return this.startReview(goalId, ref, intent.commit, repoPath, reviewReasons(state), actions);
  }

  /** Records a machine finding and resumes the same owner, unless a stop condition sends it to the Human. */
  private async repair(
    state: GoalState,
    finding: { note: string; signature: string; checkIds?: string[]; logRefs?: string[]; commit: string },
    repoPath: string,
    actions: string[],
  ): Promise<string[]> {
    const goalId = state.spec.id;
    const attempt = state.soloAttempts ?? 1;
    this.record(goalId, 'finding-recorded', { kind: 'patch', by: 'controller', attempt, ...finding });
    actions.push(`finding: ${finding.note}`);
    const repeats = (this.store.getGoal(goalId)!.findings ?? []).filter(
      item => item.kind === 'patch' && item.signature === finding.signature,
    ).length;
    if (repeats >= 3) {
      this.decide(goalId, `same failure after two repairs (${finding.signature})`, actions);
      return actions;
    }
    if (attempt >= attemptLimit(state)) {
      this.decide(goalId, `attempt budget ${attemptLimit(state)} spent`, actions);
      return actions;
    }
    if (state.appetite && this.wallMinutesUsed(goalId) > state.appetite.maxWallMinutes) {
      this.decide(goalId, `wall time ${state.appetite.maxWallMinutes} min spent`, actions);
      return actions;
    }
    this.record(goalId, 'checkpointed', {
      phase: 'controller finding',
      progress: finding.note,
      evidenceRefs: finding.logRefs ?? [],
      goalId,
      attempt: attempt + 1,
    });
    try {
      actions.push(`resumed owner: ${(await new SoloService(this.store, this.runtime).resume(goalId)).dispatchId}`);
    } catch (error) {
      actions.push(`resume refused, will retry: ${error instanceof Error ? error.message : String(error)}`);
    }
    void repoPath;
    return actions;
  }

  private async collectReview(state: GoalState, repoPath: string, actions: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const pending = state.reviewDispatch!;
    const observation = await this.runtime.inspect({
      ...state.runtimeRef!,
      dispatchId: pending.dispatchId,
      runId: pending.runId,
    });
    if (!observation.outcome) {
      // Seen live: the reviewer's brief sat in the composer like the owner's did.
      const since = [...this.store.events(goalId)].reverse().find(item => item.type === 'review-dispatched');
      actions.push(
        ...(await watchAndUnstick(
          this.store,
          this.runtime,
          this.now,
          {
            goalId,
            dispatchId: pending.dispatchId,
            runId: pending.runId,
            repoPath,
            terminal: pending.terminal,
            role: 'reviewer',
            requested: pending.requested,
            handoffHint: `apos handoff ${goalId} --reviewer --agent <other>`,
          },
          since?.at,
        )),
      );
      return actions;
    }
    await recordTelemetry(
      this.store,
      this.runtime,
      this.now,
      this.options.telemetry,
      state,
      { dispatchId: pending.dispatchId, worktreeId: pending.worktreeId } as RuntimeRef,
      'reviewer',
    );
    const result = await readReviewResult(this.runtime, repoPath, goalId, pending);
    if (!result) {
      this.decide(
        goalId,
        `reviewer ${pending.dispatchId} left no valid review at ${reviewResultPath(goalId, pending.key)}`,
        actions,
      );
      return actions;
    }
    this.record(goalId, 'review-submitted', {
      subject: 'goal',
      reviewer: 'apos-reviewer',
      session: pending.dispatchId,
      result: result.result,
      commitRef: pending.commit,
      note: result.note,
    });
    actions.push(`review ${result.result}`);
    if (result.result === 'pass') {
      new VerificationService(this.store).verify(goalId, pending.commit);
      this.record(goalId, 'human-notified', { kind: 'awaiting-outcome', goalId, deliveryCommit: pending.commit });
      actions.push('verified; awaiting Human outcome');
      return actions;
    }
    return this.repair(
      this.store.getGoal(goalId)!,
      {
        note: `Independent review requested changes on ${pending.commit}: ${result.note}`,
        signature: `review:${result.note.slice(0, 80)}`,
        commit: pending.commit,
      },
      repoPath,
      actions,
    );
  }
}
