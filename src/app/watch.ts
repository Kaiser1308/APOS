import { newEvent } from './events.js';
import type { GoalState } from '../domain/transitions.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { RuntimeAdapter } from '../ports/runtime.js';
import type { Role, RuntimeProfile } from '../domain/runtime-refs.js';

/** Quiet minutes before the screen is read for an out-of-quota line; an agent that hit its limit goes idle at once. */
export const QUOTA_CHECK_IDLE_MINUTES = 2;
/** Minutes an unsettled dispatch may sit idle before the Human is told (the same quiet spell as the controller's idle watchdog). */
export const OWNER_IDLE_MINUTES = 15;

/** The agent a dispatch runs: the profile APOS asked for, else what Orca says it launched; undefined when neither says. */
export async function dispatchAgent(
  runtime: RuntimeAdapter,
  dispatchId: string,
  requested?: { agent?: string },
): Promise<string | undefined> {
  if (requested?.agent) return requested.agent;
  try {
    return (await runtime.launchReceipt?.(dispatchId))?.agent ?? undefined;
  } catch {
    return undefined;
  }
}

/** Reads the screen of a quiet dispatch for its agent's out-of-quota line; undefined when it is not quiet enough or nothing matches. */
export async function exhaustedAgent(
  runtime: RuntimeAdapter,
  input: { dispatchId: string; terminal?: string; requested?: { agent?: string }; idleMinutes?: number },
): Promise<{ agent?: string; message: string } | undefined> {
  if (
    !runtime.agentQuota ||
    !input.terminal ||
    input.idleMinutes === undefined ||
    input.idleMinutes < QUOTA_CHECK_IDLE_MINUTES
  )
    return undefined;
  const agent = await dispatchAgent(runtime, input.dispatchId, input.requested);
  let message: string | undefined;
  try {
    message = await runtime.agentQuota(input.terminal, agent, input.dispatchId);
  } catch {
    return undefined;
  }
  return message ? { agent, message } : undefined;
}

export const exhaustedNote = (role: Role, agent: string | undefined, message: string, handoffHint: string) =>
  `the ${role} agent${agent ? ` (${agent})` : ''} has stopped on an error: "${message}". Move its work to another agent on the same worktree: \`${handoffHint}\` (this also makes that agent the ${role} profile; or omit \`--agent\` for a fresh session with the same agent).`;

/**
 * Orca reports an agent that ran out of quota itself, as an escalation on the Run (seen live 2026-11-14: subject
 * "Agent hit an error: Codex hit its usage limit.", body with "Details from the agent: You’ve hit your usage limit…").
 * Returns the agent's own line, else the subject; undefined for any other message.
 */
export function quotaEscalation(message: { type?: string; subject?: string; body?: string }): string | undefined {
  // Orca's own shape only: agents send their own escalations too, and may well talk about rate limits.
  if (message.type !== 'escalation' || !/^Agent hit an error: .*\b(usage limit|quota)\b/i.test(message.subject ?? ''))
    return undefined;
  const details = /Details from the agent:\s*(.+)/.exec(message.body ?? '')?.[1]?.trim();
  return details || (message.subject ?? '').replace(/^Agent hit an error:\s*/, '').trim();
}

/** The owner a dispatch belongs to in this Goal, and the handoff that moves it; undefined when it is none of them. */
export function ownerOf(
  state: GoalState,
  dispatchId: string,
): { role: Role; requested?: { agent?: string; model?: string }; packageId?: string; handoffHint: string } | undefined {
  const goalId = state.spec.id;
  const runtimeRef = state.runtimeRef;
  if (runtimeRef?.dispatchId === dispatchId || state.lead?.current === dispatchId)
    return {
      role: 'lead',
      requested: runtimeRef?.dispatchId === dispatchId ? runtimeRef.requested : state.lead?.ref.requested,
      handoffHint: `apos handoff ${goalId} --agent <other>`,
    };
  for (const item of Object.values(state.packages ?? {})) {
    const ref = item.runtimeRef;
    if (ref?.dispatchId === dispatchId)
      return {
        role: 'worker',
        requested: ref.requested,
        packageId: item.spec.id,
        handoffHint: `apos handoff ${goalId} --package ${item.spec.id} --agent <other>`,
      };
  }
  if (state.reviewDispatch?.dispatchId === dispatchId)
    return {
      role: 'reviewer',
      requested: state.reviewDispatch.requested,
      handoffHint: `apos handoff ${goalId} --reviewer --agent <other>`,
    };
  return undefined;
}

/** Records one agent-exhausted notice per dispatch; false when it was already recorded. */
export function recordExhausted(
  store: GoalRepository,
  now: () => number,
  input: {
    goalId: string;
    dispatchId: string;
    role: Role;
    agent?: string;
    model?: string;
    packageId?: string;
    message: string;
    handoffHint: string;
  },
): boolean {
  const seen = store
    .events(input.goalId)
    .some(
      item =>
        item.type === 'human-notified' &&
        (item.data as { kind?: string }).kind === 'agent-exhausted' &&
        (item.data as { dispatchId?: string }).dispatchId === input.dispatchId,
    );
  if (seen) return false;
  store.append(
    newEvent(
      input.goalId,
      'human-notified',
      {
        kind: 'agent-exhausted',
        goalId: input.goalId,
        dispatchId: input.dispatchId,
        role: input.role,
        ...(input.packageId ? { packageId: input.packageId } : {}),
        agent: input.agent,
        model: input.model,
        message: input.message,
        note: exhaustedNote(input.role, input.agent, input.message, input.handoffHint),
      },
      new Date(now()).toISOString(),
    ),
  );
  return true;
}

/**
 * One controller pass over a running, unsettled dispatch: an out-of-quota line on its screen is reported once, naming
 * the agent and the handoff; otherwise a dispatch idle for `idleNoticeMinutes` is reported once as owner-idle.
 */
export async function watchDispatch(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  now: () => number,
  input: {
    goalId: string;
    dispatchId: string;
    runId: string;
    repoPath: string;
    terminal?: string;
    role: Role;
    requested?: RuntimeProfile | { agent?: string; model?: string };
    packageId?: string;
    /** Default OWNER_IDLE_MINUTES; null leaves idle reporting to the caller. */
    idleNoticeMinutes?: number | null;
    handoffHint: string;
  },
): Promise<string[]> {
  let idleMinutes: number | undefined;
  try {
    idleMinutes = (
      await runtime.inspect({
        runId: input.runId,
        taskId: '',
        dispatchId: input.dispatchId,
        owner: 'lead',
        repoPath: input.repoPath,
      })
    ).idleMinutes;
  } catch {
    return [];
  }
  if (idleMinutes === undefined) return [];
  const seen = (kind: string) =>
    store
      .events(input.goalId)
      .some(
        item =>
          item.type === 'human-notified' &&
          (item.data as { kind?: string }).kind === kind &&
          (item.data as { dispatchId?: string }).dispatchId === input.dispatchId,
      );
  const record = (data: Record<string, unknown>) =>
    store.append(
      newEvent(
        input.goalId,
        'human-notified',
        {
          goalId: input.goalId,
          dispatchId: input.dispatchId,
          role: input.role,
          ...(input.packageId ? { packageId: input.packageId } : {}),
          ...data,
        },
        new Date(now()).toISOString(),
      ),
    );
  if (seen('agent-exhausted')) return [];
  const exhausted = await exhaustedAgent(runtime, {
    dispatchId: input.dispatchId,
    terminal: input.terminal,
    requested: input.requested,
    idleMinutes,
  });
  if (exhausted) {
    recordExhausted(store, now, {
      goalId: input.goalId,
      dispatchId: input.dispatchId,
      role: input.role,
      agent: exhausted.agent,
      model: input.requested?.model,
      packageId: input.packageId,
      message: exhausted.message,
      handoffHint: input.handoffHint,
    });
    return [
      `${input.role} ${input.dispatchId} stopped on an error (${exhausted.agent ?? 'unknown agent'}); Human notified`,
    ];
  }
  const threshold = input.idleNoticeMinutes === undefined ? OWNER_IDLE_MINUTES : input.idleNoticeMinutes;
  if (threshold === null || idleMinutes < threshold || seen('owner-idle')) return [];
  const minutes = Math.round(idleMinutes);
  record({
    kind: 'owner-idle',
    idleMinutes: minutes,
    note: `the ${input.role}${input.packageId ? ` of ${input.packageId}` : ''} has been idle for ${minutes} min without reporting worker_done; it may have died (wrong model, auth, crash, quota). Check the terminal in Orca or \`orca orchestration worker-show --dispatch ${input.dispatchId}\`, then \`${input.handoffHint}\` (or omit \`--agent\` for a fresh session with the same agent), \`apos execution abandon-intent\` or \`apos outcome stop\`.`,
  });
  return [`${input.role} ${input.dispatchId} idle ${minutes} min; Human notified`];
}
