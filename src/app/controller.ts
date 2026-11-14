import { PackageService, type PackageRuntime, type PackageRuntimeRef } from './packages.js';
import { SoloService } from './solo.js';
import { LeadService } from './lead.js';
import type { OrcaMessage, RuntimeAdapter, RuntimeRef } from '../runtime/orca.js';
import type { GoalRepository } from '../store/journal.js';
import { randomUUID } from 'node:crypto';
import { handingOff, type GoalState } from '../domain/transitions.js';
/** Minutes a handoff may stay pending before the Human is told. */
export const HANDOFF_PENDING_MINUTES = 10;
import { dispatchAgent, ownerOf, quotaEscalation, recordExhausted } from './watch.js';
import { MultiSupervisor, SoloSupervisor, type SupervisorOptions } from './supervisor.js';

export const IDLE_MINUTES = 15;
export type ControllerTick = { goalId: string; dispatched: string[]; recovered: string[]; unresolved: string[]; resumed: string[]; settled: string[]; inboxPending: string[]; errors: string[]; supervised: string[] };

/**
 * The standing answer to an owner's question or escalation in Solo. Seen live: an owner escalated a
 * fixture that contradicted the approved Goal, then waited. The Human hears about it; the owner is told
 * the rule it already has instead of an improvised decision.
 */
export const ESCALATION_REPLY = 'APOS controller: logged for the Human, who will read it after this attempt. Keep working under the approved Goal and .apos/skills/_core/execute.md. Approved acceptance criteria and their recorded ambiguity decisions win over existing tests or fixtures that contradict them: update those, with the criterion as the reason. Where the Goal is silent, take the reading closest to source.md and record it in your report. Report failed only if the Goal cannot be met within scope.';
const OWNER_MESSAGES = new Set(['escalation', 'question', 'decision_gate', 'blocker']);

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
      if (message.type !== 'worker_done') {
        // Orca's own report that an owner's agent ran out of quota: tell the Human who and how to hand it off. A
        // "keep working" reply would reach an agent that cannot answer.
        const quota = quotaEscalation(message);
        const payloadDispatch = message.payload && typeof message.payload === 'object' ? (message.payload as { dispatchId?: unknown }).dispatchId : undefined;
        const quotaDispatch = message.dispatchId ?? message.dispatch_id ?? (typeof payloadDispatch === 'string' ? payloadDispatch : undefined);
        const owner = quota && quotaDispatch ? ownerOf(this.store.getGoal(goalId)!, quotaDispatch) : undefined;
        if (quota && quotaDispatch && owner) {
          const agent = await dispatchAgent(this.runtime, quotaDispatch, owner.requested);
          if (recordExhausted(this.store, Date.now, { goalId, dispatchId: quotaDispatch, role: owner.role, agent, model: owner.requested?.model, packageId: owner.packageId, message: quota, handoffHint: owner.handoffHint })) result.supervised.push(`${owner.role} ${quotaDispatch} out of quota (${agent ?? 'unknown agent'}); Human notified`);
          continue;
        }
        if (state.proposal?.mode.startsWith('solo') && OWNER_MESSAGES.has(message.type)) { await this.relay(goalId, runId, message, result); continue; }
        result.inboxPending.push(`${message.type}:${message.id}`); continue;
      }
      let payload = message.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { result.inboxPending.push(`invalid payload:${message.id}`); continue; }
      }
      const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const dispatchId = message.dispatchId ?? message.dispatch_id ?? body.dispatchId ?? body.dispatch_id;
      // The reviewer's worker_done: collectReview reads the review from its worktree.
      if (dispatchId && dispatchId === this.store.getGoal(goalId)?.reviewDispatch?.dispatchId) continue;
      const ref = refs.find(item => item.dispatchId === dispatchId);
      if (!ref) {
        // The Lead's own wake-up dispatches are not owner refs, but Orca keeps the Lead terminal bound to a
        // settled dispatch until it is retained (seen live: the next wake was refused with agent_unconfigured).
        if (typeof dispatchId === 'string' && this.store.events(goalId).some(item => item.type === 'lead-woken' && (item.data as { dispatchId?: string })?.dispatchId === dispatchId)) {
          try { await this.runtime.retainWorker(dispatchId); result.settled.push(`lead:${dispatchId}`); continue; }
          catch { result.inboxPending.push(`unsettled:${message.id}`); continue; }
        }
        // Seen live: the worker_done of a reviewer whose start was lost sat in the inbox for an hour and
        // kept the delivery from being acked. Settlement never depends on this message (the controller
        // inspects each current dispatch itself), so a worker_done for any other dispatch on this Run is
        // logged once and acked.
        const note = `stale worker_done ${message.id} for dispatch ${String(dispatchId ?? 'unknown')}: not a current dispatch of this Goal; acked`;
        // A reviewer's worker_done can arrive before its start is recorded (review intent pending): not stale, and not worth a note.
        const startPending = Boolean(this.store.getGoal(goalId)?.reviewIntent || this.store.getGoal(goalId)?.resumeIntent);
        if (!startPending && !this.store.events(goalId).some(item => item.type === 'decision-logged' && (item.data as { note?: string }).note === note)) {
          this.store.append({ id: randomUUID(), goalId, type: 'decision-logged', data: { note }, at: new Date().toISOString() });
        }
        result.settled.push(`stale ${message.id}`);
        continue;
      }
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

  /**
   * While a handoff is pending the controller leaves the stopped dispatch alone, so a handoff whose CLI died would hold
   * the Goal silently. After HANDOFF_PENDING_MINUTES the Human is told once how to finish or drop it.
   */
  private noticePendingHandoff(state: GoalState, result: ControllerTick): void {
    const pending = state.handoffIntent;
    const now = (this.options.now ?? Date.now)();
    if (!pending || now - Date.parse(pending.at) < HANDOFF_PENDING_MINUTES * 60_000) return;
    const goalId = state.spec.id;
    if (this.store.events(goalId).some(item => item.type === 'human-notified' && (item.data as { key?: string }).key === pending.key)) return;
    this.store.append({ id: randomUUID(), goalId, type: 'human-notified', data: { kind: 'needs-decision', goalId, key: pending.key, note: `the handoff of ${goalId} (from ${pending.from}) has been pending for ${HANDOFF_PENDING_MINUTES}+ min. Run \`apos handoff ${goalId}${pending.target.kind === 'package' ? ` --package ${pending.target.packageId}` : pending.target.kind === 'reviewer' ? ' --reviewer' : ''}\` to finish it (it recovers an agent that started), or check Orca and \`apos execution abandon-intent ${goalId} --key ${pending.key} --reason ...\` to drop it.` }, at: new Date(now).toISOString() });
    result.supervised.push(`handoff ${pending.key} pending; Human notified`);
  }

  /** Notifies the Human once per message and answers the owner with the standing rule. */
  private async relay(goalId: string, runId: string, message: OrcaMessage, result: ControllerTick): Promise<void> {
    const seen = this.store.events(goalId).some(item => item.type === 'human-notified' && (item.data as { messageId?: string }).messageId === message.id);
    if (seen) return;
    this.store.append({ id: randomUUID(), goalId, type: 'human-notified', data: { kind: 'escalation', goalId, messageId: message.id, messageType: message.type, subject: message.subject, body: message.body }, at: new Date().toISOString() });
    if (this.runtime.replyMessage) await this.runtime.replyMessage(runId, message.id, ESCALATION_REPLY);
    result.settled.push(`relayed ${message.type}:${message.id}`);
  }

  /**
   * Seen live: a Goal sat 26 minutes with no agent running and nothing for the controller to do,
   * and no tick said so. A Solo Goal whose current dispatch has settled, with no reviewer pending and
   * no event for IDLE_MINUTES, is reported once per quiet spell.
   */
  private watchdog(goalId: string, result: ControllerTick): void {
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing' || !state.proposal) return;
    const ref = state.runtimeRef as RuntimeRef | undefined;
    // Multi-WP: no package still running and no reviewer pending (seen live: the Lead ended its turn waiting for a review nobody dispatched).
    const multiIdle = state.proposal.mode === 'multi-wp' && !state.reviewDispatch && !state.reviewIntent
      && Object.values(state.packages ?? {}).every(item => item.status !== 'executing' || !item.runtimeRef || state.settlements?.[(item.runtimeRef as { dispatchId: string }).dispatchId]);
    const idle = state.proposal.mode === 'multi-wp' ? multiIdle : ref && state.settlements?.[ref.dispatchId] && !state.reviewDispatch && !state.reviewIntent && !state.resumeIntent;
    if (!idle) return;
    const events = this.store.events(goalId);
    const last = events.at(-1)!;
    if (last.type === 'human-notified' || Date.now() - Date.parse(last.at) < IDLE_MINUTES * 60_000) return;
    this.store.append({ id: randomUUID(), goalId, type: 'human-notified', data: { kind: 'idle', goalId, since: last.at, lastEvent: last.type, note: `no agent running and no controller progress for ${IDLE_MINUTES}+ min after ${last.type}; tick errors: ${result.errors.join('; ') || 'none'}` }, at: new Date().toISOString() });
    result.supervised.push(`idle since ${last.at} after ${last.type}; Human notified`);
  }

  async tick(repoPath: string): Promise<ControllerTick[]> {
    const results: ControllerTick[] = [];
    for (const snapshot of this.store.listGoals()) {
      const goalId = snapshot.spec.id;
      const result: ControllerTick = { goalId, dispatched: [], recovered: [], unresolved: [], resumed: [], settled: [], inboxPending: [], errors: [], supervised: [] };
      this.noticePendingHandoff(snapshot, result);
      // The Lead is planning (no plan accepted yet), or its dispatch is still unknown. A running Lead whose Solo plan is
      // accepted is adopted below as the owner, so its end of turn counts as a delivery, not as a planning stop.
      const planning = ['selected', 'planned'].includes(snapshot.status) || (snapshot.status === 'ready' && snapshot.proposal?.mode !== 'multi-wp' && Boolean(snapshot.leadIntent));
      if (planning && (snapshot.lead || snapshot.leadIntent)) {
        try { result.supervised.push(...await new LeadService(this.store, this.runtime).reconcile(goalId)); }
        catch (error) { result.errors.push(`lead: ${error instanceof Error ? error.message : String(error)}`); }
        const current = this.store.getGoal(goalId)!;
        if (current.status !== 'ready' || !current.lead || current.lead.settled) { results.push(result); continue; }
      }
      if (!snapshot.proposal || !['ready', 'executing', 'blocked'].includes(snapshot.status)) continue;
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
            // A Worker being handed off was stopped on purpose and reads failed (seen live); it is not a settlement.
            const handedOff = state.handoffIntent?.from === (item.runtimeRef as PackageRuntimeRef | undefined)?.dispatchId;
            if (!handedOff && item.status === 'executing' && item.runtimeRef && this.runtime.inspectPackage && !state.settlements?.[(item.runtimeRef as PackageRuntimeRef).dispatchId]) {
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
          if (snapshot.status === 'ready') {
            const current = this.store.getGoal(goalId)!;
            if (!current.lead || current.lead.settled) {
              // Accepted under the old flow (or its Lead ended its turn): there is no Lead to own it, and no cold owner is started.
              const note = `the Solo plan of ${goalId} has no running APOS-dispatched Lead to deliver it. Run \`apos lead start ${goalId}\`; that Lead proposes and commits again.`;
              if (!this.store.events(goalId).some(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'needs-decision' && (item.data as { note?: string }).note === note)) {
                this.store.append({ id: randomUUID(), goalId, type: 'human-notified', data: { kind: 'needs-decision', goalId, note }, at: new Date().toISOString() });
              }
              result.unresolved.push('Solo plan without a Lead');
              results.push(result);
              continue;
            }
            result.dispatched.push((await service.adopt(goalId)).dispatchId);
          }
          else {
            const observed = await service.reconcile(goalId);
            if (observed === 'unverifiable') {
              result.unresolved.push('Solo dispatch unverifiable');
              const events = this.store.events(goalId);
              const intent = [...events].reverse().find(item => item.type === 'resume-intended' || item.type === 'dispatch-intended');
              const key = intent?.data as string | undefined;
              const old = intent && Date.now() - Date.parse(intent.at) > 10 * 60_000;
              if (key && old && !events.some(item => item.type === 'human-notified' && (item.data as { key?: string }).key === key)) {
                this.store.append({ id: randomUUID(), goalId, type: 'human-notified', data: { kind: 'needs-decision', goalId, key, note: `Orca outcome for intent ${key} is unknown after 10 min. Check \`orca orchestration task-list\`; if it created nothing, run \`apos execution abandon-intent ${goalId} --key ${key} --reason ...\`.` }, at: new Date().toISOString() });
              }
            }
            const current = this.store.getGoal(goalId)!;
            if (current.runtimeRef && !handingOff(current) && !current.settlements?.[(current.runtimeRef as RuntimeRef).dispatchId]) {
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
      try {
        result.supervised.push(...(snapshot.proposal.mode === 'multi-wp'
          ? await new MultiSupervisor(this.store, this.runtime, this.options).step(goalId, repoPath, result.inboxPending)
          : await new SoloSupervisor(this.store, this.runtime, this.options).step(goalId, repoPath)));
      } catch (error) { result.errors.push(`supervisor: ${error instanceof Error ? error.message : String(error)}`); }
      this.watchdog(goalId, result);
      results.push(result);
    }
    return results;
  }
}
