import { randomUUID } from 'node:crypto';
import type { GoalRepository } from '../store/journal.js';
import type { RuntimeAdapter } from '../runtime/orca.js';
import type { Role, RuntimeProfile } from '../runtime/brief.js';

/** Quiet minutes before the screen is read for an out-of-quota line; an agent that hit its limit goes idle at once. */
export const QUOTA_CHECK_IDLE_MINUTES = 2;
/** Minutes an unsettled dispatch may sit idle before the Human is told (the same quiet spell as the controller's idle watchdog). */
export const OWNER_IDLE_MINUTES = 15;

/** The agent a dispatch runs: the profile APOS asked for, else what Orca says it launched; undefined when neither says. */
export async function dispatchAgent(runtime: RuntimeAdapter, dispatchId: string, requested?: { agent?: string }): Promise<string | undefined> {
  if (requested?.agent) return requested.agent;
  try { return (await runtime.launchReceipt?.(dispatchId))?.agent ?? undefined; } catch { return undefined; }
}

/** Reads the screen of a quiet dispatch for its agent's out-of-quota line; undefined when it is not quiet enough or nothing matches. */
export async function exhaustedAgent(runtime: RuntimeAdapter, input: { dispatchId: string; terminal?: string; requested?: { agent?: string }; idleMinutes?: number }): Promise<{ agent?: string; message: string } | undefined> {
  if (!runtime.agentQuota || !input.terminal || input.idleMinutes === undefined || input.idleMinutes < QUOTA_CHECK_IDLE_MINUTES) return undefined;
  const agent = await dispatchAgent(runtime, input.dispatchId, input.requested);
  let message: string | undefined;
  try { message = await runtime.agentQuota(input.terminal, agent); } catch { return undefined; }
  return message ? { agent, message } : undefined;
}

export const exhaustedNote = (role: Role, agent: string | undefined, message: string, handoffHint: string) =>
  `the ${role} agent${agent ? ` (${agent})` : ''} is out of quota: "${message}". Move its work to another agent on the same worktree: \`${handoffHint}\` (this also makes that agent the ${role} profile).`;

/**
 * One controller pass over a running, unsettled dispatch: an out-of-quota line on its screen is reported once, naming
 * the agent and the handoff; otherwise a dispatch idle for `idleNoticeMinutes` is reported once as owner-idle.
 */
export async function watchDispatch(store: GoalRepository, runtime: RuntimeAdapter, now: () => number, input: {
  goalId: string; dispatchId: string; runId: string; repoPath: string; terminal?: string;
  role: Role; requested?: RuntimeProfile | { agent?: string; model?: string }; packageId?: string;
  /** Default OWNER_IDLE_MINUTES; null leaves idle reporting to the caller. */
  idleNoticeMinutes?: number | null;
  handoffHint: string;
}): Promise<string[]> {
  let idleMinutes: number | undefined;
  try { idleMinutes = (await runtime.inspect({ runId: input.runId, taskId: '', dispatchId: input.dispatchId, owner: 'lead', repoPath: input.repoPath })).idleMinutes; } catch { return []; }
  if (idleMinutes === undefined) return [];
  const seen = (kind: string) => store.events(input.goalId).some(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === kind && (item.data as { dispatchId?: string }).dispatchId === input.dispatchId);
  const record = (data: Record<string, unknown>) => store.append({ id: randomUUID(), goalId: input.goalId, type: 'human-notified', data: { goalId: input.goalId, dispatchId: input.dispatchId, role: input.role, ...(input.packageId ? { packageId: input.packageId } : {}), ...data }, at: new Date(now()).toISOString() });
  if (seen('agent-exhausted')) return [];
  const exhausted = await exhaustedAgent(runtime, { dispatchId: input.dispatchId, terminal: input.terminal, requested: input.requested, idleMinutes });
  if (exhausted) {
    record({ kind: 'agent-exhausted', agent: exhausted.agent, model: input.requested?.model, message: exhausted.message, note: exhaustedNote(input.role, exhausted.agent, exhausted.message, input.handoffHint) });
    return [`${input.role} ${input.dispatchId} out of quota (${exhausted.agent ?? 'unknown agent'}); Human notified`];
  }
  const threshold = input.idleNoticeMinutes === undefined ? OWNER_IDLE_MINUTES : input.idleNoticeMinutes;
  if (threshold === null || idleMinutes < threshold || seen('owner-idle')) return [];
  const minutes = Math.round(idleMinutes);
  record({ kind: 'owner-idle', idleMinutes: minutes, note: `the ${input.role}${input.packageId ? ` of ${input.packageId}` : ''} has been idle for ${minutes} min without reporting worker_done; it may have died (wrong model, auth, crash, quota). Check the terminal in Orca or \`orca orchestration worker-show --dispatch ${input.dispatchId}\`, then \`${input.handoffHint}\`, \`apos execution abandon-intent\` or \`apos outcome stop\`.` });
  return [`${input.role} ${input.dispatchId} idle ${minutes} min; Human notified`];
}
