import { execFileSync } from 'node:child_process';
import type { PhaseCheckpoint } from '../domain/contracts.js';

export type RuntimeRef = { runId: string; taskId: string; dispatchId: string; owner: 'lead'; repoPath: string; terminal?: string };
export type RuntimeObservation = { state: 'live' | 'settled' | 'unverifiable'; ref: RuntimeRef };
export type SoloInput = { repoPath: string; goalId: string; proposalVersion: number; checkpoint?: PhaseCheckpoint; idempotencyKey: string };
export interface RuntimeAdapter {
  startSolo(input: SoloInput): Promise<RuntimeRef>;
  resumeSolo(ref: RuntimeRef, checkpoint: PhaseCheckpoint): Promise<RuntimeRef>;
  inspect(ref: RuntimeRef): Promise<RuntimeObservation>;
  recover?(key: string): Promise<RuntimeRef | undefined>;
}

export function parseOrcaResult(json: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error('Orca returned non-JSON output'); }
  if (!parsed || typeof parsed !== 'object' || !('ok' in parsed) || (parsed as { ok: unknown }).ok !== true) {
    throw new Error('Orca operation failed or has unknown outcome');
  }
  const result = (parsed as { result?: unknown }).result;
  if (!result || typeof result !== 'object') throw new Error('Orca result missing');
  return result as Record<string, unknown>;
}

function runOrca(args: string[]): Record<string, unknown> {
  try {
    return parseOrcaResult(execFileSync('orca', [...args, '--json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    throw new Error(`Orca ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Orca response missing ${label}`);
  return value;
}

export function extractStartedRef(started: Record<string, unknown>, repoPath: string): RuntimeRef {
  const effects = Array.isArray(started.effects) ? started.effects.map(object) : [];
  const terminal = effects.find(effect => effect.kind === 'terminal' && effect.role === 'agent');
  return {
    runId: id(started.runId, 'Run ID'), taskId: id(started.taskId, 'Task ID'),
    dispatchId: id(started.dispatchId, 'Dispatch ID'), owner: 'lead', repoPath,
    terminal: typeof terminal?.id === 'string' ? terminal.id : undefined
  };
}

export function interpretWorkerShow(shown: Record<string, unknown>): RuntimeObservation['state'] {
  const dispatchStatus = object(shown.dispatch).status;
  if (dispatchStatus === 'completed' || dispatchStatus === 'failed') return 'settled';
  const liveness = object(object(shown.projection).liveness).verdict;
  return liveness === 'live' ? 'live' : 'unverifiable';
}

export class OrcaRuntime implements RuntimeAdapter {
  constructor(private readonly execute: (args: string[]) => Record<string, unknown> = runOrca) {}

  async startSolo(input: SoloInput): Promise<RuntimeRef> {
    this.execute(['repo', 'add', '--path', input.repoPath]);
    const run = this.execute(['orchestration', 'run-create', '--objective', `APOS ${input.goalId} proposal v${input.proposalVersion} key ${input.idempotencyKey}`]);
    const runId = id(object(run.run).id, 'Run ID');
    const spec = `Target: ${input.repoPath}, ${input.goalId}. Change: implement approved Solo Goal end to end. Constraints: read .apos/goals/${input.goalId}/goal.md and execution.md; preserve scope and user files; do not merge without authorization. Ownership: Lead owns Goal. Observable acceptance: tests and evidence for every Goal acceptance criterion. APOS dispatch key: ${input.idempotencyKey}.`;
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--worktree', `path:${input.repoPath}`, '--agent', 'claude', '--run', runId]);
    const ref = extractStartedRef(started, input.repoPath);
    if (ref.runId !== runId) throw new Error('Orca worker belongs to an unexpected Run');
    return ref;
  }

  async resumeSolo(ref: RuntimeRef, checkpoint: PhaseCheckpoint): Promise<RuntimeRef> {
    if (!ref.terminal) throw new Error('Orca terminal identity required to resume same owner');
    const spec = `Continue the same APOS Solo Goal owner from phase ${checkpoint.phase}. Progress: ${checkpoint.progress}. Evidence: ${checkpoint.evidenceRefs.join(', ')}. Keep the approved Goal contract and report verification evidence.`;
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--terminal', ref.terminal, '--worktree', `path:${ref.repoPath}`, '--run', ref.runId]);
    return extractStartedRef(started, ref.repoPath);
  }

  async inspect(ref: RuntimeRef): Promise<RuntimeObservation> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId]);
    return { state: interpretWorkerShow(shown), ref };
  }

  async recover(key: string): Promise<RuntimeRef | undefined> {
    const runs = this.execute(['orchestration', 'run-list']);
    const run = (Array.isArray(runs.runs) ? runs.runs : []).map(object).find(row => typeof row.objective === 'string' && row.objective.endsWith(`key ${key}`));
    if (!run) return undefined;
    const runId = id(run.id, 'Run ID');
    const tasks = this.execute(['orchestration', 'task-list', '--run', runId]);
    const task = (Array.isArray(tasks.tasks) ? tasks.tasks : []).map(object).find(row => typeof row.spec === 'string' && row.spec.includes(`APOS dispatch key: ${key}.`));
    if (!task) return undefined;
    const taskId = id(task.id, 'Task ID');
    const detail = this.execute(['orchestration', 'dispatch-show', '--task', taskId]);
    const dispatch = object(detail.dispatch);
    if (!dispatch.id) return undefined;
    const match = /Target: (.*?), (GOAL-[A-Z0-9-]+)\./.exec(String(task.spec));
    if (!match) throw new Error('Orca task has no APOS repo path');
    return { runId, taskId, dispatchId: id(dispatch.id, 'Dispatch ID'), owner: 'lead', repoPath: match[1], terminal: typeof dispatch.assignee_handle === 'string' ? dispatch.assignee_handle : undefined };
  }
}
