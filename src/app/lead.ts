import { randomUUID } from 'node:crypto';
import type { GoalEventType, GoalState, LeadState } from '../domain/transitions.js';
import type { GoalRepository } from '../store/journal.js';
import { resolve, sep } from 'node:path';
import { OrcaRefused, worktreePath, type RuntimeAdapter, type RuntimeRef } from '../runtime/orca.js';
import { exhaustedAgent, exhaustedNote } from './watch.js';

/** How long a Lead dispatch may stay unknown before the Human is asked to look in Orca. */
export const LEAD_INTENT_MINUTES = 10;
/** A Lead still unsettled yet idle this long is reported once per dispatch (seen live for owners: a turn that died at launch). */
export const LEAD_IDLE_MINUTES = 20;

/** The Lead's latest dispatch as a runtime reference: the Solo owner, and the target of resumes and wakes. */
export function currentLeadRef(lead: LeadState): RuntimeRef {
  return { ...lead.ref, dispatchId: lead.current, owner: 'lead', requested: lead.ref.requested as RuntimeRef['requested'] };
}

/** When the Goal's appetite clock started: the Lead's dispatch intent, else (older Goals) the Solo start. */
export function clockStart(events: { type: GoalEventType; at: string }[]): string | undefined {
  return (events.find(item => item.type === 'lead-dispatch-intended') ?? events.find(item => item.type === 'execution-started'))?.at;
}

/**
 * `lead propose` and `lead commit` belong to the Lead APOS dispatched for this Goal, from its own terminal. Otherwise
 * the Solo owner the controller adopts would not be the session that planned (the defect this replaces).
 */
export function assertLeadTerminal(state: GoalState, handle: string | undefined, command: string, cwd: string = process.cwd()): LeadState {
  const lead = state.lead;
  if (!lead) throw new Error(`${command}: no APOS-dispatched Lead for ${state.spec.id}. The Human runs \`apos lead start ${state.spec.id}\` (or \`goal select\`), and the Lead it starts runs this command.`);
  // Two signals, either enough: Orca's terminal handle, or running inside the Lead's own worktree (the handle format an
  // agent sees in ORCA_TERMINAL_HANDLE is not yet confirmed live against the start receipt).
  const tree = worktreePath(lead.ref.worktreeId);
  const here = resolve(cwd).toLowerCase();
  const inTree = Boolean(tree) && (here === resolve(tree!).toLowerCase() || here.startsWith(`${resolve(tree!).toLowerCase()}${sep}`));
  if (handle !== lead.ref.terminal && !inTree) throw new Error(`${command} must run from the Lead terminal APOS dispatched for ${state.spec.id} (${lead.ref.terminal}) or its worktree (${tree ?? 'unknown'}), not ${handle ? `terminal ${handle}` : 'a terminal outside Orca'} in ${cwd}`);
  return lead;
}

export class LeadService {
  constructor(private readonly store: GoalRepository, private readonly runtime: RuntimeAdapter, private readonly now: () => number = Date.now) {}

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append({ id: randomUUID(), goalId, type, data, at: new Date(this.now()).toISOString() });
  }

  private notifyOnce(goalId: string, kind: string, match: (data: Record<string, unknown>) => boolean, data: Record<string, unknown>): boolean {
    const seen = this.store.events(goalId).some(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === kind && match(item.data as Record<string, unknown>));
    if (!seen) this.record(goalId, 'human-notified', { kind, goalId, ...data });
    return !seen;
  }

  /** Dispatches the Lead for a selected Goal, once. A pending intent is recovered by key, never dispatched twice. */
  async start(goalId: string, repoPath: string): Promise<RuntimeRef> {
    const state = this.store.getGoal(goalId);
    if (!state) throw new Error(`Goal does not exist: ${goalId}`);
    if (state.lead && !state.lead.settled) return currentLeadRef(state.lead);
    if (state.leadIntent) {
      const recovered = await this.runtime.recover?.(state.leadIntent);
      if (!recovered) throw new Error(`Lead dispatch outcome unknown for ${goalId}; check \`orca orchestration task-list\`, then \`apos execution abandon-intent ${goalId} --key ${state.leadIntent} --reason ...\` if Orca created nothing`);
      this.record(goalId, 'lead-started', recovered);
      return recovered;
    }
    const key = randomUUID();
    this.record(goalId, 'lead-dispatch-intended', key);
    let ref: RuntimeRef;
    try { ref = await this.runtime.startLead({ repoPath, goalId, goalVersion: state.spec.version, idempotencyKey: key, budget: state.appetite ? { minutesLeft: state.appetite.maxWallMinutes, attemptsLeft: Math.max(0, state.appetite.maxAttempts - 1) } : undefined }); }
    catch (error) {
      if (error instanceof OrcaRefused) this.record(goalId, 'intent-abandoned', { key, reason: `Orca refused: ${error.code}` });
      throw error;
    }
    this.record(goalId, 'lead-started', ref);
    return ref;
  }

  /** The Human's answer to a Lead that ended its turn before its plan was accepted, delivered on the same terminal. */
  async wake(goalId: string, repoPath: string, note: string): Promise<string> {
    const state = this.store.getGoal(goalId);
    if (!state?.lead) throw new Error(`No APOS-dispatched Lead for ${goalId}`);
    if (!state.lead.settled) throw new Error(`The Lead of ${goalId} is still in its turn; wait for it to report worker_done`);
    if (!['selected', 'planned', 'ready'].includes(state.status)) throw new Error(`${goalId} is ${state.status}: the controller resumes its owner itself`);
    if (!this.runtime.wakeLead) throw new Error('Configured runtime cannot wake the Lead');
    const event = `human (${new Date(this.now()).toISOString()}): ${note}`;
    const woken = await this.runtime.wakeLead({ repoPath, goalId, terminal: state.lead.ref.terminal, worktree: `id:${state.lead.ref.worktreeId}`, runId: state.lead.ref.runId, events: [event], idempotencyKey: randomUUID(), phase: 'plan' });
    this.record(goalId, 'lead-woken', { dispatchId: woken.dispatchId, events: [event], runId: state.lead.ref.runId });
    return woken.dispatchId;
  }

  /** One controller pass over a Goal whose Lead is planning: recover, settle, and tell the Human what needs them. */
  async reconcile(goalId: string): Promise<string[]> {
    const actions: string[] = [];
    let state = this.store.getGoal(goalId);
    if (!state || !['selected', 'planned', 'ready'].includes(state.status)) return actions;
    if (state.leadIntent) {
      const key = state.leadIntent;
      const recovered = await this.runtime.recover?.(key);
      if (recovered) { this.record(goalId, 'lead-started', recovered); actions.push(`recovered Lead ${recovered.dispatchId}`); }
      else {
        const intent = [...this.store.events(goalId)].reverse().find(item => item.type === 'lead-dispatch-intended');
        if (intent && this.now() - Date.parse(intent.at) > LEAD_INTENT_MINUTES * 60_000) {
          if (this.notifyOnce(goalId, 'needs-decision', data => data.key === key, { key, note: `Orca outcome for the Lead dispatch ${key} is unknown after ${LEAD_INTENT_MINUTES} min. Check \`orca orchestration task-list\`; if it created nothing, run \`apos execution abandon-intent ${goalId} --key ${key} --reason ...\` and then \`apos lead start ${goalId}\`.` })) actions.push('Lead dispatch unknown; Human notified');
        }
        return actions;
      }
      state = this.store.getGoal(goalId)!;
    }
    const lead = state.lead;
    // A Lead being handed off was stopped on purpose (it reads failed); it did not end its turn.
    if (!lead || lead.settled || state.handoffIntent) return actions;
    const ref = currentLeadRef(lead);
    const observation = await this.runtime.inspect(ref);
    if (observation.outcome) {
      this.record(goalId, 'lead-settled', { dispatchId: lead.current, outcome: observation.outcome });
      // Orca keeps the terminal bound to a settled dispatch until it is retained; the wake needs it (seen live).
      await this.runtime.retainWorker?.(lead.current).catch(() => undefined);
      this.notifyOnce(goalId, 'lead-needs-decision', data => data.dispatchId === lead.current, { dispatchId: lead.current, outcome: observation.outcome, note: `the Lead ended its turn (${observation.outcome}) before any plan was accepted. Read its report in the Lead terminal or \`apos ui\`, decide (for example \`apos goal appetite\`), then \`apos lead wake ${goalId} --note "..."\`.` });
      actions.push(`Lead ${lead.current} settled ${observation.outcome} before a plan was accepted; Human notified`);
      return actions;
    }
    const exhausted = await exhaustedAgent(this.runtime, { dispatchId: lead.current, terminal: lead.ref.terminal, requested: ref.requested, idleMinutes: observation.idleMinutes });
    if (exhausted) {
      if (this.notifyOnce(goalId, 'agent-exhausted', data => data.dispatchId === lead.current, { dispatchId: lead.current, role: 'lead', agent: exhausted.agent, model: ref.requested?.model, message: exhausted.message, note: exhaustedNote('lead', exhausted.agent, exhausted.message, `apos handoff ${goalId} --agent <other>`) })) actions.push(`lead ${lead.current} out of quota (${exhausted.agent ?? 'unknown agent'}); Human notified`);
    } else if (this.store.events(goalId).some(item => item.type === 'human-notified' && (item.data as { kind?: string; dispatchId?: string }).kind === 'agent-exhausted' && (item.data as { dispatchId?: string }).dispatchId === lead.current)) {
      // Already reported as out of quota: not reported again as idle.
    } else if (observation.idleMinutes !== undefined && observation.idleMinutes >= LEAD_IDLE_MINUTES) {
      if (this.notifyOnce(goalId, 'lead-idle', data => data.dispatchId === lead.current, { dispatchId: lead.current, idleMinutes: Math.round(observation.idleMinutes), note: `the Lead has been idle for ${Math.round(observation.idleMinutes)} min without reporting worker_done; it may have died (wrong model, auth, crash). Check its terminal in Orca or \`orca orchestration worker-show --dispatch ${lead.current}\`.` })) actions.push(`Lead ${lead.current} idle; Human notified`);
    }
    const started = clockStart(this.store.events(goalId));
    if (state.appetite && started && (this.now() - Date.parse(started)) / 60_000 > state.appetite.maxWallMinutes) {
      if (this.notifyOnce(goalId, 'overrun', () => true, { note: 'the Lead is still planning past the approved wall time' })) actions.push('notified overrun');
    }
    return actions;
  }
}
