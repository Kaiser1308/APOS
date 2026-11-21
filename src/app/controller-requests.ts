import { randomUUID } from 'node:crypto';
import { newEvent } from './events.js';
import { LeadService } from './lead.js';
import { HandoffService } from './handoff.js';
import { LeadTransferService } from './lead-transfer.js';
import { PackageService } from './package-service.js';
import { SoloService } from './solo.js';
import { UserError } from '../domain/errors.js';
import {
  describeRequest,
  pendingRequest,
  type ControllerRequest,
  type PendingRequest,
} from '../domain/controller-requests.js';
import type { RuntimeProfiles } from '../domain/runtime-refs.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import type { ControllerTick } from './controller-notices.js';
import { driftedRuns } from './run-ownership.js';

/**
 * Records a command that would start or move an agent, for the controller to carry out at its next tick. A request
 * already waiting with the same identity is not queued twice. Returns what the CLI tells the caller.
 */
export function requestFromController(store: GoalRepository, goalId: string, request: ControllerRequest): string {
  const state = store.getGoal(goalId);
  if (!state) throw new UserError(`Goal does not exist: ${goalId}`);
  const what = describeRequest(request);
  const waiting = pendingRequest(state, request);
  if (waiting) {
    if (JSON.stringify(waiting.request) !== JSON.stringify(request))
      throw new UserError(
        `The controller already has a request to ${describeRequest(waiting.request)} for ${goalId} (${waiting.key}); wait for its next tick`,
      );
    return `The controller already has the request to ${what} for ${goalId}; it runs it at its next tick.`;
  }
  store.append(newEvent(goalId, 'controller-requested', { key: randomUUID(), request }));
  return `Requested: ${what} for ${goalId}. The controller does it at its next tick; its result and any problem show in \`apos inbox\`.`;
}

/**
 * Carries out the Goal's queued requests, oldest first, with the same services the commands used to call. Each runs
 * once: its outcome or error is recorded on `controller-request-settled`, and an error reaches the Human as a notice.
 * Services that write an intent first (Lead start, handoff, resumes) are settled after they ran, so a crash in between
 * recovers by key on the next tick. A Lead wake has no intent: it is settled before it runs, so it never runs twice.
 */
export async function runControllerRequests(
  store: GoalRepository,
  runtime: RuntimeAdapter & PackageRuntime,
  profiles: () => RuntimeProfiles,
  goalId: string,
  repoPath: string,
): Promise<{ done: string[]; errors: string[] }> {
  const done: string[] = [];
  const errors: string[] = [];
  for (const item of store.getGoal(goalId)?.requests ?? []) {
    const settleFirst = item.request.kind === 'lead-wake';
    if (settleFirst) store.append(newEvent(goalId, 'controller-request-settled', { key: item.key, taken: true }));
    try {
      const result = await execute(store, runtime, profiles, goalId, repoPath, item);
      if (!settleFirst) store.append(newEvent(goalId, 'controller-request-settled', { key: item.key, result }));
      done.push(`${describeRequest(item.request)}: ${result}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!settleFirst) store.append(newEvent(goalId, 'controller-request-settled', { key: item.key, error: detail }));
      store.append(
        newEvent(goalId, 'human-notified', {
          kind: 'request-failed',
          goalId,
          key: item.key,
          request: item.request,
          note: `the controller could not ${describeRequest(item.request)} for ${goalId}: ${detail}.${retryHint(store, goalId, item.request)}`,
        }),
      );
      errors.push(`${describeRequest(item.request)}: ${detail}`);
    }
  }
  return { done, errors };
}

/** What the Human does after a failed request: a Lead start whose outcome is unknown is checked, never retried blind. */
function retryHint(store: GoalRepository, goalId: string, request: ControllerRequest): string {
  if (request.kind !== 'lead-start') return '';
  const key = store.getGoal(goalId)?.leadIntent;
  return key
    ? ` Do not retry yet: check \`orca orchestration task-list --run <run_id>\` (find \`<run_id>\` with \`orca orchestration run-list\`), then \`apos execution abandon-intent ${goalId} --key ${key} --reason ...\` if Orca created nothing, then \`apos lead start ${goalId}\`.`
    : ` Retry with \`apos lead start ${goalId}\`.`;
}

async function execute(
  store: GoalRepository,
  runtime: RuntimeAdapter & PackageRuntime,
  profiles: () => RuntimeProfiles,
  goalId: string,
  repoPath: string,
  item: PendingRequest,
): Promise<string> {
  const request = item.request;
  switch (request.kind) {
    case 'lead-start':
      return `Lead ${(await new LeadService(store, runtime).start(goalId, repoPath)).dispatchId}`;
    case 'lead-wake':
      return `woke Lead ${await new LeadService(store, runtime).wake(goalId, repoPath, request.note)}`;
    case 'handoff': {
      const handed = await new HandoffService(store, runtime, profiles).handoff(goalId, request.target, repoPath);
      return `handed off to ${handed.dispatchId}${handed.warning ? ` (warning: ${handed.warning})` : ''}`;
    }
    case 'lead-to-bot': {
      const moved = await new LeadTransferService(store, runtime, profiles).toBot(
        goalId,
        request.bot,
        request.by,
        repoPath,
      );
      return `Lead moved to bot ${moved.bot.name} (${moved.bot.id}); stopped ${moved.from}${moved.warning ? ` (warning: ${moved.warning})` : ''}`;
    }
    case 'lead-to-apos': {
      const back = await new LeadTransferService(store, runtime, profiles).back(goalId, request.by, repoPath);
      return `Lead returned from its bot: ${back.note}${back.dispatchId ? ` (${back.dispatchId})` : ''}`;
    }
    case 'package-resume':
      return `resumed ${(await new PackageService(store, runtime).resumeStale(goalId, request.packageId)).dispatchId}`;
    case 'execution-resume':
      return `resumed ${(await new SoloService(store, runtime).resume(goalId)).dispatchId}`;
    case 'worker-answer':
      return answerWorker(store, runtime, goalId, request);
  }
}

const ACTIVE = ['selected', 'planned', 'ready', 'executing', 'blocked'];

/**
 * The first step of a Goal's tick. While a Run of the Goal is coordinated by another terminal the Goal is left alone,
 * its requests still queued; otherwise its queued requests run before anything else, so the tick's own resume or
 * dispatch sees what they started. True when the tick skips the Goal.
 */
export async function openGoalTick(
  store: GoalRepository,
  runtime: RuntimeAdapter & PackageRuntime,
  profiles: () => RuntimeProfiles,
  goalId: string,
  repoPath: string,
  controller: string | undefined,
  result: ControllerTick,
): Promise<boolean> {
  const state = store.getGoal(goalId);
  if (!state) return true;
  if (controller && ACTIVE.includes(state.status)) {
    try {
      const drifted = await driftedRuns(store, runtime, goalId, controller);
      if (drifted.length) {
        result.unresolved.push(...drifted);
        return true;
      }
    } catch (error) {
      result.errors.push(`run coordinator: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  }
  if (!state.requests?.length) return false;
  const ran = await runControllerRequests(store, runtime, profiles, goalId, repoPath);
  result.dispatched.push(...ran.done);
  result.errors.push(...ran.errors);
  return false;
}

/**
 * The Lead's answer to a Worker's question, sent on the package's Run by the controller, which coordinates it. The
 * answer is logged with the message it answers, so the controller stops holding that question on its next read.
 */
async function answerWorker(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  goalId: string,
  request: Extract<ControllerRequest, { kind: 'worker-answer' }>,
): Promise<string> {
  const ref = store.getGoal(goalId)?.packages?.[request.packageId]?.runtimeRef;
  if (!ref) throw new UserError(`${request.packageId} of ${goalId} has no Worker to answer`);
  if (!runtime.replyMessage) throw new UserError('Configured runtime cannot reply to a Worker');
  await runtime.replyMessage(ref.runId, request.messageId, request.text);
  store.append(
    newEvent(goalId, 'decision-logged', {
      note: `Lead answered ${request.messageId} from the Worker of ${request.packageId}: ${request.reason}`,
      answers: request.messageId,
      packageId: request.packageId,
      text: request.text,
    }),
  );
  return `replied on Run ${ref.runId}`;
}
