import { InvariantError } from './errors.js';
import type { GoalEvent, GoalState, HandoffTarget } from './transitions.js';

/**
 * A command that would start or move an agent. Only the controller starts workers and coordinates the Runs (Orca
 * fences `worker-start --run` and `check --run` to a Run's coordinator, and `run-use` takes a Run from its holder),
 * so the command records one of these and the controller carries it out at its next tick.
 */
export type ControllerRequest =
  | { kind: 'lead-start' }
  | { kind: 'lead-wake'; note: string }
  | { kind: 'handoff'; target: Exclude<HandoffTarget, { kind: 'bot' }> }
  | { kind: 'lead-to-bot'; bot: string; by: string }
  | { kind: 'lead-to-apos'; by: string }
  | { kind: 'package-resume'; packageId: string }
  | { kind: 'execution-resume' }
  | { kind: 'worker-answer'; packageId: string; messageId: string; text: string; reason: string };

export type PendingRequest = { key: string; at: string; request: ControllerRequest };

const KINDS = new Set<string>([
  'lead-start',
  'lead-wake',
  'handoff',
  'lead-to-bot',
  'lead-to-apos',
  'package-resume',
  'execution-resume',
  'worker-answer',
]);

/** Two requests with the same identity are one: a second `apos lead start` before the tick asks for nothing new. */
export const requestIdentity = (request: ControllerRequest): string =>
  request.kind === 'package-resume'
    ? `package-resume:${request.packageId}`
    : request.kind === 'worker-answer'
      ? `worker-answer:${request.messageId}`
      : request.kind === 'handoff'
        ? `handoff:${request.target.kind === 'package' ? `package:${request.target.packageId}` : request.target.kind}`
        : request.kind === 'lead-to-bot' || request.kind === 'lead-to-apos'
          ? 'lead-transfer'
          : request.kind;

/** The pending request with the same identity, if one is waiting for the controller. */
export const pendingRequest = (state: GoalState, request: ControllerRequest): PendingRequest | undefined =>
  (state.requests ?? []).find(item => requestIdentity(item.request) === requestIdentity(request));

/** What the CLI prints for a request: the command the controller runs for it. */
export function describeRequest(request: ControllerRequest): string {
  switch (request.kind) {
    case 'lead-start':
      return 'start the Lead';
    case 'lead-wake':
      return 'wake the Lead';
    case 'handoff':
      return request.target.kind === 'package'
        ? `hand off the Worker of ${request.target.packageId}`
        : request.target.kind === 'reviewer'
          ? 'hand off the reviewer'
          : 'hand off the Lead';
    case 'lead-to-bot':
      return `move the Lead to bot ${request.bot}`;
    case 'lead-to-apos':
      return 'give the Lead back to a fresh APOS Lead';
    case 'package-resume':
      return `resume the Worker of ${request.packageId}`;
    case 'execution-resume':
      return 'resume the Solo owner';
    case 'worker-answer':
      return `answer ${request.messageId} from the Worker of ${request.packageId}`;
  }
}

/**
 * `controller-requested` queues a request; `controller-request-settled` removes it once the controller ran it (the
 * outcome, or the error the Human is told about, rides on the event). The CLI checks a request before recording it,
 * so a breach here is a defect.
 */
export function applyControllerRequest(state: GoalState, event: GoalEvent): GoalState {
  const pending = state.requests ?? [];
  if (event.type === 'controller-requested') {
    const data = event.data as { key?: string; request?: ControllerRequest } | undefined;
    if (!data?.key || !data.request || !KINDS.has(data.request.kind))
      throw new InvariantError('A controller request needs its key and a known kind');
    if (pending.some(item => item.key === data.key)) throw new InvariantError(`Request ${data.key} is already queued`);
    if (pendingRequest(state, data.request))
      throw new InvariantError(`The controller already has a request to ${describeRequest(data.request)}`);
    return { ...state, requests: [...pending, { key: data.key, at: event.at, request: data.request }] };
  }
  const data = event.data as { key?: string } | undefined;
  if (!data?.key || !pending.some(item => item.key === data.key))
    throw new InvariantError(`No queued controller request ${data?.key ?? ''}`);
  const rest = pending.filter(item => item.key !== data.key);
  return { ...state, requests: rest.length ? rest : undefined };
}
