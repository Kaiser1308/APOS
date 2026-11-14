import { clockStart } from './lead.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { GoalEventType, GoalState } from '../domain/transitions.js';
import { attemptLimit } from '../domain/transitions.js';
import { requiresIndependentReview, reviewReasons } from '../domain/reviews.js';
import type { GateReport } from '../domain/gate.js';
import type { GoalRepository } from '../store/journal.js';
import { CORE_SKILL, activationLine, committedFileDigest, packageReportPath, reviewResultPath, soloReportPath } from '../runtime/brief.js';
import { worktreePath, type RuntimeAdapter, type RuntimeRef } from '../runtime/orca.js';
import type { TelemetryProbe } from '../runtime/telemetry.js';
import { GateService } from './gate.js';
import { SoloService } from './solo.js';
import { VerificationService } from './verification.js';
import { PackageService, type PackageRuntime, type PackageRuntimeRef } from './packages.js';
import { GitCommitInspector, IntegrationService, type CommitInspector } from './integration.js';

/** Minutes an unsettled owner may sit idle before the Human is told (the same quiet spell as the controller's idle watchdog). */
const OWNER_IDLE_MINUTES = 15;

const show = (repo: string, commit: string, path: string): string | undefined => {
  try { return execFileSync('git', ['-C', repo, 'show', `${commit}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return undefined; }
};

export type SupervisorOptions = { gate?: GateService; telemetry?: TelemetryProbe; now?: () => number; inspector?: CommitInspector };

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
    const started = clockStart(this.store.events(goalId));
    return started ? (this.now() - Date.parse(started)) / 60_000 : 0;
  }

  /**
   * Seen live: an owner's turn died at launch (`model_not_found`), Orca kept it `live idle`, no worker_done ever came and
   * the Goal sat `executing` with nothing in the inbox. An owner that is still unsettled yet idle for OWNER_IDLE_MINUTES is
   * reported once per dispatch, with how to look and how to recover.
   */
  private async noticeIdleOwner(goalId: string, ref: RuntimeRef): Promise<string[]> {
    if (!this.runtime.inspect) return [];
    let idleMinutes: number | undefined;
    try { idleMinutes = (await this.runtime.inspect(ref)).idleMinutes; } catch { return []; }
    if (idleMinutes === undefined || idleMinutes < OWNER_IDLE_MINUTES) return [];
    const noticed = this.store.events(goalId).some(item => item.type === 'human-notified' && (item.data as { kind?: string; dispatchId?: string }).kind === 'owner-idle' && (item.data as { dispatchId?: string }).dispatchId === ref.dispatchId);
    if (noticed) return [];
    this.record(goalId, 'human-notified', { kind: 'owner-idle', goalId, dispatchId: ref.dispatchId, idleMinutes: Math.round(idleMinutes), note: `owner has been idle for ${Math.round(idleMinutes)} min without reporting worker_done; it may have died (wrong model, auth, crash). Check the terminal in Orca or \`orca orchestration worker-show --dispatch ${ref.dispatchId}\`, then \`apos execution abandon-intent\` or \`apos outcome stop\`.` });
    return [`owner ${ref.dispatchId} idle ${Math.round(idleMinutes)} min; Human notified`];
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
      const since = [...this.store.events(goalId)].reverse().find(item => ['execution-started', 'runtime-resumed'].includes(item.type));
      actions.push(...await this.noticeIdleOwner(goalId, ref));
      actions.push(...await unstickDispatch(this.store, this.runtime, this.now, { goalId, dispatchId: ref.dispatchId, terminal: ref.terminal, since: since?.at }));
      return actions;
    }
    if (state.reviewDispatch) return this.collectReview(state, repoPath, actions);
    const attempt = state.soloAttempts ?? 1;
    if ((state.findings ?? []).some(item => item.attempt === attempt && item.by === 'controller')) {
      // A repair the controller already decided on but Orca refused to start: retry, bounded.
      if (state.checkpoint && !state.resumeIntent) {
        const refusals = this.store.events(goalId).filter(item => item.type === 'intent-abandoned').length;
        if (refusals >= 3) { this.decide(goalId, `Orca refused to resume the owner ${refusals} times`, actions); return actions; }
        try { actions.push(`resumed owner: ${(await new SoloService(this.store, this.runtime).resume(goalId)).dispatchId}`); }
        catch (error) { actions.push(`resume refused, will retry: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return actions;
    }

    // After the repair check: a review that asks for changes leaves a green gate behind (seen live).
    if (state.gate?.attemptKey && state.gate.result === 'green') {
      if (state.reviewIntent && state.status === 'executing') return this.recoverReview(state, ref, repoPath, actions);
      return actions;
    }

    await this.recordTelemetry(state, ref, 'lead');
    if (outcome === 'failed') {
      // Seen live: an owner reported failed with most of the Goal built and 75 of 90 minutes left. While the
      // appetite lasts, an honest "not done" is a finding for the same owner, not a stop. repair() enforces the budget.
      const failedHead = await this.runtime.deliveryHead?.(ref);
      const failedReport = failedHead && show(repoPath, failedHead, soloReportPath(goalId, attempt));
      const failedLine = ref.baseCommit ? activationLine(committedFileDigest(repoPath, ref.baseCommit, CORE_SKILL)) : undefined;
      if (!failedHead || !failedReport || !failedLine || !failedReport.includes(failedLine)) { this.decide(goalId, `owner reported failed on attempt ${attempt} without a delivery report`, actions); return actions; }
      return this.repair(state, {
        note: `You reported failed on attempt ${attempt} at ${failedHead}, and the approved budget is not spent. Your report says what remains: ${remaining(failedReport)} Finish it. Report failed again only if the Goal cannot be met within scope, naming the requirement that blocks it.`,
        signature: 'owner-incomplete', commit: failedHead
      }, repoPath, actions);
    }
    const receipt = await this.runtime.launchReceipt?.(ref.dispatchId);
    if (ref.requested?.model && receipt?.model && receipt.model !== ref.requested.model) {
      this.decide(goalId, `runtime launched ${receipt.agent}/${receipt.model}, plan requires ${ref.requested.agent}/${ref.requested.model}`, actions);
      return actions;
    }
    const head = await this.runtime.deliveryHead?.(ref);
    if (!head || !ref.baseCommit) { this.decide(goalId, 'delivery commit unknown: owner worktree or base commit missing', actions); return actions; }
    // Seen live: an owner told the repo path committed into the managed checkout instead of its worktree.
    const intruders = foreignCommits(repoPath, ref.baseCommit, goalId);
    if (intruders.length) { this.decide(goalId, `the owner's delivery landed in the managed checkout instead of its worktree: ${intruders.join(', ')}`, actions); return actions; }

    const report = show(repoPath, head, soloReportPath(goalId, attempt));
    const line = activationLine(committedFileDigest(repoPath, ref.baseCommit, CORE_SKILL));
    if (!report || !report.includes(line)) {
      return this.repair(state, { note: report ? `Delivery report lacks the activation line "${line}": the core execution skill was not loaded as briefed.` : `No delivery report committed at ${soloReportPath(goalId, attempt)} on ${head}.`, signature: report ? 'activation' : 'no-report', commit: head }, repoPath, actions);
    }

    const gate = this.gate.run(goalId, repoPath, { deliveryCommit: head });
    actions.push(`gate ${gate.result} on ${head}`);
    if (gate.result === 'green') {
      const reasons = reviewReasons(this.store.getGoal(goalId)!);
      if (reasons.length && this.runtime.startReviewer) return this.startReview(goalId, ref, head, repoPath, reasons, actions);
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

  /** The intent is recorded first: seen live, Orca created the reviewer but reported its start as outcome-unknown. */
  private async startReview(goalId: string, ref: RuntimeRef, head: string, repoPath: string, reasons: string[], actions: string[]): Promise<string[]> {
    const key = randomUUID();
    this.record(goalId, 'review-intended', { key, commit: head });
    try {
      const reviewer = await this.runtime.startReviewer!({ repoPath, goalId, baseCommit: ref.baseCommit!, commit: head, reasons, idempotencyKey: key, runId: ref.runId });
      this.record(goalId, 'review-dispatched', { dispatchId: reviewer.dispatchId, runId: reviewer.runId, key, commit: head, worktreeId: reviewer.worktreeId, terminal: reviewer.terminal });
      actions.push(`reviewer ${reviewer.dispatchId}: ${reasons.join('; ')}`);
    } catch (error) {
      actions.push(`reviewer start outcome unknown, will recover by key: ${error instanceof Error ? error.message : String(error)}`);
    }
    return actions;
  }

  private async recoverReview(state: GoalState, ref: RuntimeRef, repoPath: string, actions: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const intent = state.reviewIntent!;
    const found = await this.runtime.recover?.(intent.key, ref.runId);
    if (found) {
      this.record(goalId, 'review-dispatched', { dispatchId: found.dispatchId, runId: found.runId, key: intent.key, commit: intent.commit, worktreeId: found.worktreeId, terminal: found.terminal });
      actions.push(`recovered reviewer ${found.dispatchId}`);
      return actions;
    }
    if (this.now() - Date.parse(intent.at) < 3 * 60_000) return actions;
    const tries = this.store.events(goalId).filter(item => item.type === 'review-intended').length;
    if (tries >= 3 || !this.runtime.startReviewer || !ref.baseCommit) { this.decide(goalId, `reviewer for ${intent.commit} could not be started or found after ${tries} tries`, actions); return actions; }
    return this.startReview(goalId, ref, intent.commit, repoPath, reviewReasons(state), actions);
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
    try { actions.push(`resumed owner: ${(await new SoloService(this.store, this.runtime).resume(goalId)).dispatchId}`); }
    catch (error) { actions.push(`resume refused, will retry: ${error instanceof Error ? error.message : String(error)}`); }
    void repoPath;
    return actions;
  }

  private async collectReview(state: GoalState, repoPath: string, actions: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const pending = state.reviewDispatch!;
    const observation = await this.runtime.inspect({ ...(state.runtimeRef as RuntimeRef), dispatchId: pending.dispatchId, runId: pending.runId });
    if (!observation.outcome) {
      // Seen live: the reviewer's brief sat in the composer like the owner's did.
      const since = [...this.store.events(goalId)].reverse().find(item => item.type === 'review-dispatched');
      actions.push(...await unstickDispatch(this.store, this.runtime, this.now, { goalId, dispatchId: pending.dispatchId, terminal: pending.terminal, since: since?.at }));
      return actions;
    }
    await this.recordTelemetry(state, { dispatchId: pending.dispatchId, worktreeId: pending.worktreeId } as RuntimeRef, 'reviewer');
    const head = await this.runtime.deliveryHead?.({ worktreeId: pending.worktreeId, dispatchId: pending.dispatchId });
    const raw = head && show(repoPath, head, reviewResultPath(goalId, pending.key));
    let result: { result?: string; note?: string } | undefined;
    // PowerShell writes a UTF-8 BOM (seen live: a valid review was rejected).
    try { result = raw ? JSON.parse(raw.replace(/^﻿/, '')) : undefined; } catch { result = undefined; }
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
    const events = this.store.events(state.spec.id);
    // A Solo owner is the Lead: its window opens when the Lead was dispatched, so planning counts (design: lead-owns-solo Q2).
    const startedAt = events.findIndex(item => ['lead-started', 'execution-started', 'runtime-resumed', 'review-dispatched'].includes(item.type) && (item.data as { dispatchId?: string })?.dispatchId === ref.dispatchId);
    // The window opens at the dispatch intent: a dispatch recovered later was already running before it was recorded (seen live).
    const intent = startedAt > 0 && ['dispatch-intended', 'resume-intended', 'lead-dispatch-intended'].includes(events[startedAt - 1].type) ? events[startedAt - 1] : undefined;
    const started = intent ?? (startedAt >= 0 ? events[startedAt] : undefined);
    const path = worktreePath(ref.worktreeId);
    const until = new Date(this.now()).toISOString();
    const usage = path && started ? this.options.telemetry?.usage({ worktreePath: path, since: started.at, until }) : undefined;
    this.record(state.spec.id, 'telemetry-recorded', {
      dispatchId: ref.dispatchId, role, requestedModel: ref.requested?.model, launchedModel: receipt?.model ?? usage?.model,
      usage: usage ?? 'unknown', ...(started ? { wallMs: this.now() - Date.parse(started.at) } : {})
    });
  }
}

/**
 * Seen live with Codex in Orca: a brief pasted but never submitted, for owners, resumes and reviewers.
 * Orca never resends, so the controller owns this: from one quiet minute on, while the screen shows an
 * unsent brief, press Enter up to three times a minute apart; then the Human is told. An agent that is
 * visibly working is never reported.
 */
export async function unstickDispatch(store: GoalRepository, runtime: RuntimeAdapter, now: () => number, input: { goalId: string; dispatchId: string; terminal?: string; since?: string }): Promise<string[]> {
  if (!runtime.nudge || !input.terminal || !input.since) return [];
  if (now() - Date.parse(input.since) < 60_000) return [];
  const pending = runtime.composerPending ? await runtime.composerPending(input.terminal) : await runtime.inputStalled?.(input.dispatchId);
  if (!pending) return [];
  const marker = `nudge ${input.dispatchId}`;
  const events = store.events(input.goalId);
  const nudges = events.filter(item => item.type === 'decision-logged' && String((item.data as { note?: string }).note).startsWith(marker));
  const record = (type: GoalEventType, data: unknown) => store.append({ id: randomUUID(), goalId: input.goalId, type, data, at: new Date(now()).toISOString() });
  if (nudges.length < 3) {
    if (nudges.length && now() - Date.parse(nudges.at(-1)!.at) < 60_000) return [];
    await runtime.nudge(input.terminal);
    record('decision-logged', { note: `${marker}: brief unsent in the composer; controller pressed Enter (${nudges.length + 1}/3)` });
    return [`nudged ${input.dispatchId} (${nudges.length + 1}/3)`];
  }
  const notified = events.some(item => item.type === 'human-notified' && (item.data as { kind?: string; dispatchId?: string }).kind === 'stalled' && (item.data as { dispatchId?: string }).dispatchId === input.dispatchId);
  if (notified || now() - Date.parse(nudges.at(-1)!.at) < 60_000) return [];
  record('human-notified', { kind: 'stalled', goalId: input.goalId, dispatchId: input.dispatchId, note: 'brief still unsent after three Enters' });
  return [`stalled ${input.dispatchId}; Human notified`];
}

/**
 * Non-APOS commits on the managed checkout since the base that touch this Goal's evidence: the
 * signature of an owner working in the checkout. Ordinary Human commits elsewhere are not flagged.
 */
function foreignCommits(repoPath: string, base: string, goalId: string): string[] {
  try {
    const rows = execFileSync('git', ['-C', repoPath, 'log', '--format=%H%x09%ae', `${base}..HEAD`, '--', `.apos/goals/${goalId}/evidence/`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean);
    return rows.filter(row => row.split('\t')[1] !== 'apos@local.invalid').map(row => row.slice(0, 12));
  } catch { return []; }
}

/** The owner's own account of unfinished work: its "Remaining" section, else the end of the report. */
function remaining(report: string): string {
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex(line => /^#+\s*Remaining/i.test(line));
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && /^#+\s/.test(line));
  const section = start < 0 ? '' : lines.slice(start + 1, end < 0 ? undefined : end).join(' ').trim();
  return (section || report.trim().slice(-800)).slice(0, 1500);
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
      if (!outcome) {
        const since = [...this.store.events(goalId)].reverse().find(event => ['package-started', 'package-resumed'].includes(event.type) && JSON.stringify(event.data ?? '').includes(ref.dispatchId));
        actions.push(...await unstickDispatch(this.store, this.runtime, this.now, { goalId, dispatchId: ref.dispatchId, terminal: ref.terminal, since: since?.at }));
        continue;
      }
      if (item.gate?.attemptKey === attemptKey) continue;
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
    actions.push(...await this.goalReview(goalId, repoPath, events));
    state = this.store.getGoal(goalId)!;
    // Derived from the recorded review, not from the tick that read it: a wake Orca refuses is retried.
    const verdict = state.gate && !state.integration ? [...state.reviews].reverse().find(item => item.subject === 'goal' && item.commitRef.toLowerCase() === state!.gate!.deliveryCommit.toLowerCase()) : undefined;
    if (verdict) events.push(verdict.result === 'pass'
      ? `Goal review passed on ${verdict.commitRef}: submit the acceptance evidence and run "apos integration complete ${goalId} --file <json>" for that commit`
      : `Goal review requested changes on ${verdict.commitRef}: ${verdict.note}`);
    const packages = Object.values(state.packages ?? {});
    if (packages.length && packages.every(item => item.status === 'verified') && !state.integration) events.push('all packages verified: ready to integrate');
    if (state.gate && state.gate.result !== 'green') events.push(`integration gate ${state.gate.result} on ${state.gate.deliveryCommit}`);
    actions.push(...await this.wakeLead(goalId, repoPath, events));
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
    if (state.integration || !gate || gate.result !== 'green' || !packages.length || !packages.every(item => item.status === 'verified')) return actions;
    if (!requiresIndependentReview(state)) return actions;
    const commit = gate.deliveryCommit;
    if (state.reviews.some(item => item.subject === 'goal' && item.commitRef.toLowerCase() === commit.toLowerCase())) return actions;
    const inspector = this.options.inspector ?? new GitCommitInspector();
    try {
      const prepared = new IntegrationService(this.store, inspector).prepare(goalId, repoPath);
      const missing = prepared.commits.filter(item => !inspector.contains(repoPath, item, commit));
      if (missing.length) {
        // Seen live: this returned silently and the Goal stalled until the Lead found the cause itself.
        events.push(`Goal review waiting: gated integration commit ${commit} does not contain package commit(s) ${missing.join(', ')} as ancestors; rebuild it with "git merge --no-ff" of every package commit (no squash or rebase), then run the gate again`);
        return actions;
      }
    } catch { return actions; }
    return this.startGoalReview(state, commit, repoPath, actions);
  }

  private reviewRun(state: GoalState): string | undefined {
    return state.leadTerminal?.runId ?? Object.values(state.packages ?? {}).map(item => (item.runtimeRef as PackageRuntimeRef | undefined)?.runId).find(Boolean);
  }

  private async startGoalReview(state: GoalState, commit: string, repoPath: string, actions: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const runId = this.reviewRun(state);
    if (!runId || !state.proposal?.baseCommit) return actions;
    const key = randomUUID();
    this.record(goalId, 'review-intended', { key, commit });
    try {
      const reviewer = await this.runtime.startReviewer!({ repoPath, goalId, baseCommit: state.proposal.baseCommit, commit, reasons: reviewReasons(state), idempotencyKey: key, runId });
      this.record(goalId, 'review-dispatched', { dispatchId: reviewer.dispatchId, runId: reviewer.runId, key, commit, worktreeId: reviewer.worktreeId, terminal: reviewer.terminal });
      actions.push(`Goal reviewer ${reviewer.dispatchId} on ${commit}`);
    } catch (error) {
      actions.push(`Goal reviewer start outcome unknown, will recover by key: ${error instanceof Error ? error.message : String(error)}`);
    }
    return actions;
  }

  private async recoverGoalReview(state: GoalState, repoPath: string, actions: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const intent = state.reviewIntent!;
    const runId = this.reviewRun(state);
    const found = await this.runtime.recover?.(intent.key, runId ?? '');
    if (found) {
      this.record(goalId, 'review-dispatched', { dispatchId: found.dispatchId, runId: found.runId, key: intent.key, commit: intent.commit, worktreeId: found.worktreeId, terminal: found.terminal });
      actions.push(`recovered Goal reviewer ${found.dispatchId}`);
      return actions;
    }
    if (this.now() - Date.parse(intent.at) < 3 * 60_000) return actions;
    const tries = this.store.events(goalId).filter(item => item.type === 'review-intended').length;
    if (tries >= 3) {
      this.record(goalId, 'blocked', { kind: 'technical', note: `needs-decision: Goal reviewer for ${intent.commit} could not be started or found after ${tries} tries` });
      this.record(goalId, 'human-notified', { kind: 'needs-decision', goalId, note: `Goal reviewer for ${intent.commit} could not be started or found after ${tries} tries` });
      actions.push('needs-decision: Goal reviewer could not be started');
      return actions;
    }
    return this.startGoalReview(state, intent.commit, repoPath, actions);
  }

  private async collectGoalReview(state: GoalState, repoPath: string, events: string[]): Promise<string[]> {
    const goalId = state.spec.id;
    const actions: string[] = [];
    const pending = state.reviewDispatch!;
    const observation = await this.runtime.inspect({ runId: pending.runId, taskId: '', dispatchId: pending.dispatchId, owner: 'lead', repoPath });
    if (!observation.outcome) {
      const since = [...this.store.events(goalId)].reverse().find(item => item.type === 'review-dispatched');
      actions.push(...await unstickDispatch(this.store, this.runtime, this.now, { goalId, dispatchId: pending.dispatchId, terminal: pending.terminal, since: since?.at }));
      return actions;
    }
    const head = await this.runtime.deliveryHead?.({ worktreeId: pending.worktreeId, dispatchId: pending.dispatchId });
    const raw = head && show(repoPath, head, reviewResultPath(goalId, pending.key));
    let result: { result?: string; note?: string } | undefined;
    try { result = raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : undefined; } catch { result = undefined; }
    if (!result || !['pass', 'changes'].includes(result.result ?? '') || !result.note?.trim()) {
      const note = `Goal reviewer ${pending.dispatchId} left no valid review at ${reviewResultPath(goalId, pending.key)}`;
      this.record(goalId, 'blocked', { kind: 'technical', note: `needs-decision: ${note}` });
      this.record(goalId, 'human-notified', { kind: 'needs-decision', goalId, note });
      actions.push(`needs-decision: ${note}`);
      return actions;
    }
    this.record(goalId, 'review-submitted', { subject: 'goal', reviewer: 'apos-reviewer', session: pending.dispatchId, result: result.result, commitRef: pending.commit, note: result.note });
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
      const asked = this.store.events(goalId).some(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'lead-unreachable');
      if (!asked) this.record(goalId, 'human-notified', { kind: 'lead-unreachable', goalId, events: fresh });
      return [`Lead unreachable for: ${fresh.join('; ')}`];
    }
    const lastWake = [...this.store.events(goalId)].reverse().find(item => item.type === 'lead-woken' && (item.data as { dispatchId?: string }).dispatchId);
    const lastDispatch = (lastWake?.data as { dispatchId?: string } | undefined)?.dispatchId;
    if (lastDispatch) {
      const observation = await this.runtime.inspect({ runId: lead.runId ?? '', taskId: '', dispatchId: lastDispatch, owner: 'lead', repoPath });
      if (!observation.outcome) return [...await unstickDispatch(this.store, this.runtime, this.now, { goalId, dispatchId: lastDispatch, terminal: lead.terminal, since: lastWake!.at }), `Lead busy; holding ${fresh.length} event(s)`];
      // Orca keeps the terminal bound to a settled dispatch until it is retained, and refuses the next wake (seen live:
      // agent_unconfigured). The Lead's dispatches live on its own Run, which the inbox does not read, so retain here.
      await this.runtime.retainWorker?.(lastDispatch);
    }
    const runId = lead.runId ?? (Object.values(state.packages ?? {}).map(item => (item.runtimeRef as PackageRuntimeRef | undefined)?.runId).find(Boolean));
    if (!runId) return [];
    const woken = await this.runtime.wakeLead({ repoPath, goalId, terminal: lead.terminal, worktree: lead.worktree, runId, events: fresh, idempotencyKey: randomUUID() });
    this.record(goalId, 'lead-woken', { dispatchId: woken.dispatchId, events: fresh, runId });
    return [`woke Lead ${woken.dispatchId}: ${fresh.join('; ')}`];
  }
}
