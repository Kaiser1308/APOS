import { dispatchReviewer, readReviewResult, show, watchAndUnstick } from './supervision.js';
import { newEvent } from './events.js';
import { randomUUID } from 'node:crypto';
import type { GoalEventType, GoalState } from '../domain/transitions.js';
import { handingOff } from '../domain/transitions.js';
import { requiresIndependentReview, reviewReasons } from '../domain/reviews.js';
import {
  CORE_SKILL,
  aposCommand,
  activationLine,
  committedFileDigest,
  packageReportPath,
  reviewResultPath,
} from '../runtime/brief.js';
import { isDeadSession } from '../runtime/orca.js';
import { GateService } from './gate.js';
import { PackageService } from './packages.js';
import { GitCommitInspector, IntegrationService } from './integration.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import type { SupervisorOptions } from './solo-supervisor.js';

/**
 * The controller's loop for a Multi-WP Goal: gate each settled package on its own head, send red
 * packages back to the same owner with the finding, and wake the Lead once per batch of new events
 * (settled packages, Worker questions, ready-to-integrate, a red integration gate) on its terminal.
 */
export class MultiSupervisor {
  private readonly gate: GateService;
  private readonly now: () => number;
  constructor(
    private readonly store: GoalRepository,
    private readonly runtime: RuntimeAdapter & PackageRuntime,
    private readonly options: SupervisorOptions = {},
  ) {
    this.gate = options.gate ?? new GateService(store);
    this.now = options.now ?? Date.now;
  }

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append(newEvent(goalId, type, data, new Date(this.now()).toISOString()));
  }

  async step(goalId: string, repoPath: string, questions: string[] = []): Promise<string[]> {
    const actions: string[] = [];
    let state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing' || state.proposal?.mode !== 'multi-wp' || handingOff(state))
      return actions;
    const events: string[] = questions.map(item => `question ${item}`);
    for (const item of Object.values(state.packages ?? {})) {
      const ref = item.runtimeRef;
      if (item.status !== 'executing' || !ref) continue;
      const outcome = state.settlements?.[ref.dispatchId];
      const attemptKey = `${item.spec.id}@${item.spec.version}:${item.attempts}`;
      if (!outcome) {
        const since = [...this.store.events(goalId)]
          .reverse()
          .find(
            event =>
              ['package-started', 'package-resumed'].includes(event.type) &&
              JSON.stringify(event.data ?? '').includes(ref.dispatchId),
          );
        actions.push(
          ...(await watchAndUnstick(
            this.store,
            this.runtime,
            this.now,
            {
              goalId,
              dispatchId: ref.dispatchId,
              runId: ref.runId,
              repoPath,
              terminal: ref.terminal,
              role: 'worker',
              requested: ref.requested,
              packageId: item.spec.id,
              handoffHint: `apos handoff ${goalId} --package ${item.spec.id} --agent <other>`,
            },
            since?.at,
          )),
        );
        continue;
      }
      if (item.gate?.attemptKey === attemptKey) continue;
      const tag = `${item.spec.id} v${item.spec.version} attempt ${item.attempts}`;
      if (outcome === 'failed') {
        this.record(goalId, 'package-blocked', {
          packageId: item.spec.id,
          blocker: { kind: 'technical', note: `Worker reported failed on ${tag}` },
        });
        events.push(`package ${tag} failed`);
        continue;
      }
      const head = await this.runtime.deliveryHead?.(ref);
      const report =
        head && show(repoPath, head, packageReportPath(goalId, item.spec.id, item.spec.version, item.attempts));
      const line = ref.baseCommit
        ? activationLine(committedFileDigest(repoPath, ref.baseCommit, CORE_SKILL))
        : undefined;
      if (!head || !report || !line || !report.includes(line)) {
        // Not gated, so it cannot verify; the Lead decides whether to revise and resume the owner.
        events.push(`package ${tag} settled without a delivery report carrying the core activation line`);
        continue;
      }
      if (!item.spec.acceptance.some(criterion => criterion.checkIds?.length)) {
        events.push(`package ${tag} settled at ${head}; no controller checks, Lead must verify its evidence`);
        continue;
      }
      const gate = this.gate.runPackage(goalId, item.spec.id, repoPath, head);
      actions.push(`${item.spec.id} gate ${gate.result} on ${head}`);
      if (gate.result === 'green') {
        const service = new PackageService(this.store, this.runtime);
        for (const criterion of item.spec.acceptance)
          service.submitEvidence(goalId, {
            packageId: item.spec.id,
            packageVersion: item.spec.version,
            owner: item.spec.owner,
            acceptanceId: criterion.id,
            result: 'pass',
            command: 'controller package gate',
            artifactRef: gate.gateId,
            commitRef: head,
          });
        if (!state.proposal.risks.length) {
          await service.verify(goalId, item.spec.id);
          events.push(`package ${tag} verified at ${head}`);
        } else events.push(`package ${tag} green at ${head}; independent package review required`);
        continue;
      }
      const latest = this.store.getGoal(goalId)!.packages![item.spec.id];
      const signature = latest.findings?.at(-1);
      const repeats = (latest.findings ?? []).filter(value => value === signature).length;
      if (gate.result === 'unverifiable' || repeats >= 3) {
        this.record(goalId, 'human-notified', {
          kind: 'needs-decision',
          goalId,
          packageId: item.spec.id,
          note: gate.result === 'unverifiable' ? 'package gate unverifiable' : 'same package failure after two repairs',
        });
        events.push(`package ${tag} needs a decision: ${latest.finding}`);
      } else events.push(`package ${tag} red, returned to its owner: ${latest.finding}`);
    }
    actions.push(...(await this.goalReview(goalId, repoPath, events)));
    state = this.store.getGoal(goalId)!;
    // Derived from the recorded review, not from the tick that read it: a wake Orca refuses is retried.
    const verdict =
      state.gate && !state.integration
        ? [...state.reviews]
            .reverse()
            .find(
              item =>
                item.subject === 'goal' && item.commitRef.toLowerCase() === state!.gate!.deliveryCommit.toLowerCase(),
            )
        : undefined;
    if (verdict)
      events.push(
        verdict.result === 'pass'
          ? `Goal review passed on ${verdict.commitRef}: submit the acceptance evidence and run ${aposCommand(repoPath)} integration complete ${goalId} --file <json> for that commit`
          : `Goal review requested changes on ${verdict.commitRef}: ${verdict.note}`,
      );
    const packages = Object.values(state.packages ?? {});
    if (packages.length && packages.every(item => item.status === 'verified') && !state.integration)
      events.push('all packages verified: ready to integrate');
    if (state.gate && state.gate.result !== 'green')
      events.push(`integration gate ${state.gate.result} on ${state.gate.deliveryCommit}`);
    actions.push(...(await this.wakeLead(goalId, repoPath, events)));
    return actions;
  }

  /**
   * Seen live: after the integration gate went green nobody dispatched the Goal reviewer, `integration
   * complete` refuses without it, and the Lead (rightly) ended its turn, so the Goal sat idle. The
   * controller now owns this review: intent first, one reviewer per gated integration commit, and the
   * Lead is woken with the verdict and the exact next step.
   */
  private async goalReview(goalId: string, repoPath: string, events: string[]): Promise<string[]> {
    const state = this.store.getGoal(goalId)!;
    const actions: string[] = [];
    if (!this.runtime.startReviewer) return actions;
    if (state.reviewDispatch) return this.collectGoalReview(state, repoPath, events);
    const gate = state.gate;
    const packages = Object.values(state.packages ?? {});
    if (state.reviewIntent) return this.recoverGoalReview(state, repoPath, actions);
    if (
      state.integration ||
      !gate ||
      gate.result !== 'green' ||
      !packages.length ||
      !packages.every(item => item.status === 'verified')
    )
      return actions;
    if (!requiresIndependentReview(state)) return actions;
    const commit = gate.deliveryCommit;
    if (state.reviews.some(item => item.subject === 'goal' && item.commitRef.toLowerCase() === commit.toLowerCase()))
      return actions;
    const inspector = this.options.inspector ?? new GitCommitInspector();
    try {
      const prepared = new IntegrationService(this.store, inspector).prepare(goalId, repoPath);
      const missing = prepared.commits.filter(item => !inspector.contains(repoPath, item, commit));
      if (missing.length) {
        // Seen live: this returned silently and the Goal stalled until the Lead found the cause itself.
        events.push(
          `Goal review waiting: gated integration commit ${commit} does not contain package commit(s) ${missing.join(', ')} as ancestors; rebuild it with "git merge --no-ff" of every package commit (no squash or rebase), then run the gate again`,
        );
        return actions;
      }
    } catch {
      return actions;
    }
    return this.startGoalReview(state, commit, repoPath, actions);
  }

  private reviewRun(state: GoalState): string | undefined {
    return (
      state.leadTerminal?.runId ??
      Object.values(state.packages ?? {})
        .map(item => item.runtimeRef?.runId)
        .find(Boolean)
    );
  }

  private async startGoalReview(
    state: GoalState,
    commit: string,
    repoPath: string,
    actions: string[],
  ): Promise<string[]> {
    const goalId = state.spec.id;
    const runId = this.reviewRun(state);
    if (!runId || !state.proposal?.baseCommit) return actions;
    actions.push(
      await dispatchReviewer(
        this.store,
        this.runtime,
        this.now,
        { goalId, repoPath, baseCommit: state.proposal.baseCommit, commit, reasons: reviewReasons(state), runId },
        {
          started: dispatchId => `Goal reviewer ${dispatchId} on ${commit}`,
          unknown: 'Goal reviewer start outcome unknown, will recover by key',
        },
      ),
    );
    return actions;
  }

  private async recoverGoalReview(state: GoalState, repoPath: string, actions: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const intent = state.reviewIntent!;
    const runId = this.reviewRun(state);
    const found = await this.runtime.recover?.(intent.key, runId ?? '');
    if (found) {
      this.record(goalId, 'review-dispatched', {
        dispatchId: found.dispatchId,
        runId: found.runId,
        key: intent.key,
        commit: intent.commit,
        worktreeId: found.worktreeId,
        terminal: found.terminal,
      });
      actions.push(`recovered Goal reviewer ${found.dispatchId}`);
      return actions;
    }
    if (this.now() - Date.parse(intent.at) < 3 * 60_000) return actions;
    const tries = this.store.events(goalId).filter(item => item.type === 'review-intended').length;
    if (tries >= 3) {
      this.record(goalId, 'blocked', {
        kind: 'technical',
        note: `needs-decision: Goal reviewer for ${intent.commit} could not be started or found after ${tries} tries`,
      });
      this.record(goalId, 'human-notified', {
        kind: 'needs-decision',
        goalId,
        note: `Goal reviewer for ${intent.commit} could not be started or found after ${tries} tries`,
      });
      actions.push('needs-decision: Goal reviewer could not be started');
      return actions;
    }
    return this.startGoalReview(state, intent.commit, repoPath, actions);
  }

  private async collectGoalReview(state: GoalState, repoPath: string, events: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const actions: string[] = [];
    const pending = state.reviewDispatch!;
    const observation = await this.runtime.inspect({
      runId: pending.runId,
      taskId: '',
      dispatchId: pending.dispatchId,
      owner: 'lead',
      repoPath,
    });
    if (!observation.outcome) {
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
    const result = await readReviewResult(this.runtime, repoPath, goalId, pending);
    if (!result) {
      const note = `Goal reviewer ${pending.dispatchId} left no valid review at ${reviewResultPath(goalId, pending.key)}`;
      this.record(goalId, 'blocked', { kind: 'technical', note: `needs-decision: ${note}` });
      this.record(goalId, 'human-notified', { kind: 'needs-decision', goalId, note });
      actions.push(`needs-decision: ${note}`);
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
    actions.push(`Goal review ${result.result}`);
    void events; // the Lead is told from the recorded review, so a refused wake is retried (see step)
    return actions;
  }

  /** One wake-up per batch of new events, only when the Lead's previous turn has settled. */
  private async wakeLead(goalId: string, repoPath: string, events: string[]): Promise<string[]> {
    const state = this.store.getGoal(goalId)!;
    const fresh = [...new Set(events)].filter(item => !(state.wokenFor ?? []).includes(item));
    if (!fresh.length) return [];
    const lead = state.leadTerminal;
    if (!lead || !this.runtime.wakeLead) {
      const asked = this.store
        .events(goalId)
        .some(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'lead-unreachable');
      if (!asked) this.record(goalId, 'human-notified', { kind: 'lead-unreachable', goalId, events: fresh });
      return [`Lead unreachable for: ${fresh.join('; ')}`];
    }
    // The Lead's latest turn: its last wake, or a fresh agent a handoff started (which must settle and be retained first).
    const lastWake = [...this.store.events(goalId)]
      .reverse()
      .find(
        item =>
          (item.type === 'lead-woken' && (item.data as { dispatchId?: string }).dispatchId) ||
          (item.type === 'owner-handed-off' && (item.data as { target?: { kind?: string } }).target?.kind === 'lead'),
      );
    const lastDispatch =
      lastWake?.type === 'owner-handed-off'
        ? (lastWake.data as { ref?: { dispatchId?: string } }).ref?.dispatchId
        : (lastWake?.data as { dispatchId?: string } | undefined)?.dispatchId;
    if (lastDispatch) {
      const observation = await this.runtime.inspect({
        runId: lead.runId ?? '',
        taskId: '',
        dispatchId: lastDispatch,
        owner: 'lead',
        repoPath,
      });
      if (!observation.outcome) {
        const requested = state.lead?.ref.requested;
        return [
          ...(await watchAndUnstick(
            this.store,
            this.runtime,
            this.now,
            {
              goalId,
              dispatchId: lastDispatch,
              runId: lead.runId ?? '',
              repoPath,
              terminal: lead.terminal,
              role: 'lead',
              requested,
              handoffHint: `apos handoff ${goalId} --agent <other>`,
            },
            lastWake!.at,
          )),
          `Lead busy; holding ${fresh.length} event(s)`,
        ];
      }
      // Orca keeps the terminal bound to a settled dispatch until it is retained, and refuses the next wake (seen live:
      // agent_unconfigured). The Lead's dispatches live on its own Run, which the inbox does not read, so retain here.
      await this.runtime.retainWorker?.(lastDispatch);
    }
    const runId =
      lead.runId ??
      Object.values(state.packages ?? {})
        .map(item => item.runtimeRef?.runId)
        .find(Boolean);
    if (!runId) return [];
    // One key per Lead turn: a wake whose response was lost is recovered by it instead of starting a second fresh Lead.
    let woken: Awaited<ReturnType<NonNullable<RuntimeAdapter['wakeLead']>>>;
    try {
      woken = await this.runtime.wakeLead({
        repoPath,
        goalId,
        terminal: lead.terminal,
        worktree: lead.worktree,
        runId,
        events: fresh,
        idempotencyKey: `wake-${lastDispatch ?? state.lead?.current ?? randomUUID()}`,
        requested: state.lead?.ref.requested,
        baseCommit: state.lead?.ref.baseCommit,
        goalVersion: state.spec.version,
      });
    } catch (error) {
      // The session that owned this wake has ended (chat closed): retrying cannot work. A fresh Lead takes over the worktree and finds the pending events itself.
      if (!isDeadSession(error) || !this.options.freshLead) throw error;
      await this.options.freshLead(goalId, repoPath);
      return [`Lead session ended; started a fresh Lead for: ${fresh.join('; ')}`];
    }
    this.record(goalId, 'lead-woken', {
      dispatchId: woken.dispatchId,
      events: fresh,
      runId,
      ...(woken.terminal ? { terminal: woken.terminal, worktree: lead.worktree, requested: woken.requested } : {}),
    });
    return [`woke Lead ${woken.dispatchId}: ${fresh.join('; ')}`];
  }
}
