import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { GoalEventType, GoalState } from '../domain/transitions.js';
import { attemptLimit } from '../domain/transitions.js';
import { reviewReasons } from '../domain/reviews.js';
import type { GateReport } from '../domain/gate.js';
import type { GoalRepository } from '../store/journal.js';
import { CORE_SKILL, activationLine, committedFileDigest, packageReportPath, reviewResultPath, soloReportPath } from '../runtime/brief.js';
import { worktreePath, type RuntimeAdapter, type RuntimeRef } from '../runtime/orca.js';
import type { TelemetryProbe } from '../runtime/telemetry.js';
import { GateService } from './gate.js';
import { SoloService } from './solo.js';
import { VerificationService } from './verification.js';
import { PackageService, type PackageRuntime, type PackageRuntimeRef } from './packages.js';

const show = (repo: string, commit: string, path: string): string | undefined => {
  try { return execFileSync('git', ['-C', repo, 'show', `${commit}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return undefined; }
};

export type SupervisorOptions = { gate?: GateService; telemetry?: TelemetryProbe; now?: () => number };

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
  constructor(private readonly store: GoalRepository, private readonly runtime: RuntimeAdapter, private readonly options: SupervisorOptions = {}) {
    this.gate = options.gate ?? new GateService(store);
    this.now = options.now ?? Date.now;
  }

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append({ id: randomUUID(), goalId, type, data, at: new Date(this.now()).toISOString() });
  }

  private decide(goalId: string, note: string, actions: string[]): void {
    this.record(goalId, 'blocked', { kind: 'technical', note: `needs-decision: ${note}` });
    this.record(goalId, 'human-notified', { kind: 'needs-decision', goalId, note });
    actions.push(`needs-decision: ${note}`);
  }

  private wallMinutesUsed(goalId: string): number {
    const started = this.store.events(goalId).find(item => item.type === 'execution-started');
    return started ? (this.now() - Date.parse(started.at)) / 60_000 : 0;
  }

  async step(goalId: string, repoPath: string): Promise<string[]> {
    const actions: string[] = [];
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing' || !state.proposal?.mode.startsWith('solo') || !state.runtimeRef) return actions;
    const ref = state.runtimeRef as RuntimeRef;
    const overTime = state.appetite && this.wallMinutesUsed(goalId) > state.appetite.maxWallMinutes;
    const outcome = state.settlements?.[ref.dispatchId];
    if (!outcome) {
      const noticed = this.store.events(goalId).some(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'overrun');
      if (overTime && !noticed) { this.record(goalId, 'human-notified', { kind: 'overrun', goalId, note: 'owner still running past the approved wall time' }); actions.push('notified overrun'); }
      return actions;
    }
    if (state.reviewDispatch) return this.collectReview(state, repoPath, actions);
    if (state.gate?.attemptKey && state.gate.result === 'green') return actions;
    const attempt = state.soloAttempts ?? 1;
    if ((state.findings ?? []).some(item => item.attempt === attempt && item.by === 'controller')) return actions;

    await this.recordTelemetry(state, ref, 'lead');
    if (outcome === 'failed') { this.decide(goalId, `owner reported failed on attempt ${attempt}`, actions); return actions; }
    const receipt = await this.runtime.launchReceipt?.(ref.dispatchId);
    if (ref.requested?.model && receipt?.model && receipt.model !== ref.requested.model) {
      this.decide(goalId, `runtime launched ${receipt.agent}/${receipt.model}, plan requires ${ref.requested.agent}/${ref.requested.model}`, actions);
      return actions;
    }
    const head = await this.runtime.deliveryHead?.(ref);
    if (!head || !ref.baseCommit) { this.decide(goalId, 'delivery commit unknown: owner worktree or base commit missing', actions); return actions; }

    const report = show(repoPath, head, soloReportPath(goalId, attempt));
    const line = activationLine(committedFileDigest(repoPath, ref.baseCommit, CORE_SKILL));
    if (!report || !report.includes(line)) {
      return this.repair(state, { note: report ? `Delivery report lacks the activation line "${line}": the core execution skill was not loaded as briefed.` : `No delivery report committed at ${soloReportPath(goalId, attempt)} on ${head}.`, signature: report ? 'activation' : 'no-report', commit: head }, repoPath, actions);
    }

    const gate = this.gate.run(goalId, repoPath, { deliveryCommit: head });
    actions.push(`gate ${gate.result} on ${head}`);
    if (gate.result === 'green') {
      const reasons = reviewReasons(this.store.getGoal(goalId)!);
      if (reasons.length && this.runtime.startReviewer) {
        const key = randomUUID();
        const reviewer = await this.runtime.startReviewer({ repoPath, goalId, baseCommit: ref.baseCommit, commit: head, reasons, idempotencyKey: key, runId: ref.runId });
        this.record(goalId, 'review-dispatched', { dispatchId: reviewer.dispatchId, runId: reviewer.runId, key, commit: head, worktreeId: reviewer.worktreeId, terminal: reviewer.terminal });
        actions.push(`reviewer ${reviewer.dispatchId}: ${reasons.join('; ')}`);
        return actions;
      }
      if (reasons.length) { this.decide(goalId, `review required (${reasons.join('; ')}) but no reviewer runtime`, actions); return actions; }
      new VerificationService(this.store).verify(goalId, head);
      this.record(goalId, 'human-notified', { kind: 'awaiting-outcome', goalId, deliveryCommit: head });
      actions.push('verified; awaiting Human outcome');
      return actions;
    }
    if (gate.result === 'pending') { this.record(goalId, 'human-notified', { kind: 'manual-check', goalId, deliveryCommit: head, checks: gate.checks.filter(item => item.status === 'manual-pending').map(item => item.checkId) }); actions.push('awaiting manual check'); return actions; }
    if (gate.result === 'unverifiable') { this.decide(goalId, `gate unverifiable on ${head}: ${describe(gate)}`, actions); return actions; }
    const failing = gate.checks.filter(item => item.status === 'fail');
    return this.repair(state, {
      note: `Controller gate red on ${head}: ${describe(gate)}`,
      signature: failing.map(item => `${item.checkId}[${item.newFailures.join(',')}]`).sort().join('|'),
      checkIds: failing.map(item => item.checkId),
      logRefs: failing.flatMap(item => item.delivery.map(run => run.logRef)),
      commit: head
    }, repoPath, actions);
  }

  /** Records a machine finding and resumes the same owner, unless a stop condition sends it to the Human. */
  private async repair(state: GoalState, finding: { note: string; signature: string; checkIds?: string[]; logRefs?: string[]; commit: string }, repoPath: string, actions: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const attempt = state.soloAttempts ?? 1;
    this.record(goalId, 'finding-recorded', { kind: 'patch', by: 'controller', attempt, ...finding });
    actions.push(`finding: ${finding.note}`);
    const repeats = (this.store.getGoal(goalId)!.findings ?? []).filter(item => item.kind === 'patch' && item.signature === finding.signature).length;
    if (repeats >= 3) { this.decide(goalId, `same failure after two repairs (${finding.signature})`, actions); return actions; }
    if (attempt >= attemptLimit(state)) { this.decide(goalId, `attempt budget ${attemptLimit(state)} spent`, actions); return actions; }
    if (state.appetite && this.wallMinutesUsed(goalId) > state.appetite.maxWallMinutes) { this.decide(goalId, `wall time ${state.appetite.maxWallMinutes} min spent`, actions); return actions; }
    this.record(goalId, 'checkpointed', { phase: 'controller finding', progress: finding.note, evidenceRefs: finding.logRefs ?? [], goalId, attempt: attempt + 1 });
    const next = await new SoloService(this.store, this.runtime).resume(goalId);
    actions.push(`resumed owner: ${next.dispatchId}`);
    void repoPath;
    return actions;
  }

  private async collectReview(state: GoalState, repoPath: string, actions: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const pending = state.reviewDispatch!;
    const observation = await this.runtime.inspect({ ...(state.runtimeRef as RuntimeRef), dispatchId: pending.dispatchId, runId: pending.runId });
    if (!observation.outcome) return actions;
    await this.recordTelemetry(state, { dispatchId: pending.dispatchId, worktreeId: pending.worktreeId } as RuntimeRef, 'reviewer');
    const head = await this.runtime.deliveryHead?.({ worktreeId: pending.worktreeId });
    const raw = head && show(repoPath, head, reviewResultPath(goalId, pending.key));
    let result: { result?: string; note?: string } | undefined;
    try { result = raw ? JSON.parse(raw) : undefined; } catch { result = undefined; }
    if (!result || !['pass', 'changes'].includes(result.result ?? '') || !result.note?.trim()) { this.decide(goalId, `reviewer ${pending.dispatchId} left no valid review at ${reviewResultPath(goalId, pending.key)}`, actions); return actions; }
    this.record(goalId, 'review-submitted', { subject: 'goal', reviewer: 'apos-reviewer', session: pending.dispatchId, result: result.result, commitRef: pending.commit, note: result.note });
    actions.push(`review ${result.result}`);
    if (result.result === 'pass') {
      new VerificationService(this.store).verify(goalId, pending.commit);
      this.record(goalId, 'human-notified', { kind: 'awaiting-outcome', goalId, deliveryCommit: pending.commit });
      actions.push('verified; awaiting Human outcome');
      return actions;
    }
    return this.repair(this.store.getGoal(goalId)!, { note: `Independent review requested changes on ${pending.commit}: ${result.note}`, signature: `review:${result.note.slice(0, 80)}`, commit: pending.commit }, repoPath, actions);
  }

  private async recordTelemetry(state: GoalState, ref: RuntimeRef, role: 'lead' | 'worker' | 'reviewer'): Promise<void> {
    if (state.telemetry?.some(item => item.dispatchId === ref.dispatchId)) return;
    const receipt = await this.runtime.launchReceipt?.(ref.dispatchId).catch(() => undefined);
    const started = [...this.store.events(state.spec.id)].reverse().find(item => ['execution-started', 'runtime-resumed', 'review-dispatched'].includes(item.type) && (item.data as { dispatchId?: string })?.dispatchId === ref.dispatchId);
    const path = worktreePath(ref.worktreeId);
    const until = new Date(this.now()).toISOString();
    const usage = path && started ? this.options.telemetry?.usage({ worktreePath: path, since: started.at, until }) : undefined;
    this.record(state.spec.id, 'telemetry-recorded', {
      dispatchId: ref.dispatchId, role, requestedModel: ref.requested?.model, launchedModel: receipt?.model,
      usage: usage ?? 'unknown', ...(started ? { wallMs: this.now() - Date.parse(started.at) } : {})
    });
  }
}

function describe(gate: GateReport): string {
  return gate.checks.filter(item => item.status !== 'pass').map(item => `${item.checkId} ${item.status} (${item.reason}${item.newFailures.length ? `; new: ${item.newFailures.join(', ')}` : ''})`).join('; ');
}

/**
 * The controller's loop for a Multi-WP Goal: gate each settled package on its own head, send red
 * packages back to the same owner with the finding, and wake the Lead once per batch of new events
 * (settled packages, Worker questions, ready-to-integrate, a red integration gate) on its terminal.
 */
export class MultiSupervisor {
  private readonly gate: GateService;
  private readonly now: () => number;
  constructor(private readonly store: GoalRepository, private readonly runtime: RuntimeAdapter & PackageRuntime, private readonly options: SupervisorOptions = {}) {
    this.gate = options.gate ?? new GateService(store);
    this.now = options.now ?? Date.now;
  }

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append({ id: randomUUID(), goalId, type, data, at: new Date(this.now()).toISOString() });
  }

  async step(goalId: string, repoPath: string, questions: string[] = []): Promise<string[]> {
    const actions: string[] = [];
    let state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing' || state.proposal?.mode !== 'multi-wp') return actions;
    const events: string[] = questions.map(item => `question ${item}`);
    for (const item of Object.values(state.packages ?? {})) {
      const ref = item.runtimeRef as PackageRuntimeRef | undefined;
      if (item.status !== 'executing' || !ref) continue;
      const outcome = state.settlements?.[ref.dispatchId];
      const attemptKey = `${item.spec.id}@${item.spec.version}:${item.attempts}`;
      if (!outcome || item.gate?.attemptKey === attemptKey) continue;
      const tag = `${item.spec.id} v${item.spec.version} attempt ${item.attempts}`;
      if (outcome === 'failed') { this.record(goalId, 'package-blocked', { packageId: item.spec.id, blocker: { kind: 'technical', note: `Worker reported failed on ${tag}` } }); events.push(`package ${tag} failed`); continue; }
      const head = await this.runtime.deliveryHead?.(ref);
      const report = head && show(repoPath, head, packageReportPath(goalId, item.spec.id, item.spec.version, item.attempts));
      const line = ref.baseCommit ? activationLine(committedFileDigest(repoPath, ref.baseCommit, CORE_SKILL)) : undefined;
      if (!head || !report || !line || !report.includes(line)) {
        // Not gated, so it cannot verify; the Lead decides whether to revise and resume the owner.
        events.push(`package ${tag} settled without a delivery report carrying the core activation line`);
        continue;
      }
      if (!item.spec.acceptance.some(criterion => criterion.checkIds?.length)) { events.push(`package ${tag} settled at ${head}; no controller checks, Lead must verify its evidence`); continue; }
      const gate = this.gate.runPackage(goalId, item.spec.id, repoPath, head);
      actions.push(`${item.spec.id} gate ${gate.result} on ${head}`);
      if (gate.result === 'green') {
        const service = new PackageService(this.store, this.runtime);
        for (const criterion of item.spec.acceptance) service.submitEvidence(goalId, { packageId: item.spec.id, packageVersion: item.spec.version, owner: item.spec.owner, acceptanceId: criterion.id, result: 'pass', command: 'controller package gate', artifactRef: gate.gateId, commitRef: head });
        if (!state.proposal.risks.length) { await service.verify(goalId, item.spec.id); events.push(`package ${tag} verified at ${head}`); }
        else events.push(`package ${tag} green at ${head}; independent package review required`);
        continue;
      }
      const latest = this.store.getGoal(goalId)!.packages![item.spec.id];
      const signature = latest.findings?.at(-1);
      const repeats = (latest.findings ?? []).filter(value => value === signature).length;
      if (gate.result === 'unverifiable' || repeats >= 3) {
        this.record(goalId, 'human-notified', { kind: 'needs-decision', goalId, packageId: item.spec.id, note: gate.result === 'unverifiable' ? 'package gate unverifiable' : 'same package failure after two repairs' });
        events.push(`package ${tag} needs a decision: ${latest.finding}`);
      } else events.push(`package ${tag} red, returned to its owner: ${latest.finding}`);
    }
    state = this.store.getGoal(goalId)!;
    const packages = Object.values(state.packages ?? {});
    if (packages.length && packages.every(item => item.status === 'verified') && !state.integration) events.push('all packages verified: ready to integrate');
    if (state.gate && state.gate.result !== 'green') events.push(`integration gate ${state.gate.result} on ${state.gate.deliveryCommit}`);
    actions.push(...await this.wakeLead(goalId, repoPath, events));
    return actions;
  }

  /** One wake-up per batch of new events, only when the Lead's previous turn has settled. */
  private async wakeLead(goalId: string, repoPath: string, events: string[]): Promise<string[]> {
    const state = this.store.getGoal(goalId)!;
    const fresh = [...new Set(events)].filter(item => !(state.wokenFor ?? []).includes(item));
    if (!fresh.length) return [];
    const lead = state.leadTerminal;
    if (!lead || !this.runtime.wakeLead) {
      const asked = this.store.events(goalId).some(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'lead-unreachable');
      if (!asked) this.record(goalId, 'human-notified', { kind: 'lead-unreachable', goalId, events: fresh });
      return [`Lead unreachable for: ${fresh.join('; ')}`];
    }
    const lastWake = [...this.store.events(goalId)].reverse().find(item => item.type === 'lead-woken' && (item.data as { dispatchId?: string }).dispatchId);
    const lastDispatch = (lastWake?.data as { dispatchId?: string } | undefined)?.dispatchId;
    if (lastDispatch) {
      const observation = await this.runtime.inspect({ runId: lead.runId ?? '', taskId: '', dispatchId: lastDispatch, owner: 'lead', repoPath });
      if (!observation.outcome) return [`Lead busy; holding ${fresh.length} event(s)`];
    }
    const runId = lead.runId ?? (Object.values(state.packages ?? {}).map(item => (item.runtimeRef as PackageRuntimeRef | undefined)?.runId).find(Boolean));
    if (!runId) return [];
    const woken = await this.runtime.wakeLead({ repoPath, goalId, terminal: lead.terminal, worktree: lead.worktree, runId, events: fresh, idempotencyKey: randomUUID() });
    this.record(goalId, 'lead-woken', { dispatchId: woken.dispatchId, events: fresh, runId });
    return [`woke Lead ${woken.dispatchId}: ${fresh.join('; ')}`];
  }
}
