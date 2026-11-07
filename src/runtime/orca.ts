import { execFileSync } from 'node:child_process';
import type { PhaseCheckpoint } from '../domain/contracts.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import type { PackageRuntimeRef } from '../app/packages.js';

export type RuntimeRef = { runId: string; taskId: string; dispatchId: string; owner: 'lead'; repoPath: string; terminal?: string; worktreeId?: string };
export type RuntimeObservation = { state: 'live' | 'settled' | 'unverifiable'; outcome?: 'completed' | 'failed'; ref: RuntimeRef };
export type OrcaMessage = { id: string; type: string; subject?: string; body?: string; payload?: unknown; dispatch_id?: string; dispatchId?: string };
export type OrcaDelivery = { deliveryId?: string; messages: OrcaMessage[] };
export type SoloInput = { repoPath: string; goalId: string; proposalVersion: number; checkpoint?: PhaseCheckpoint; idempotencyKey: string };
export interface RuntimeAdapter {
  startSolo(input: SoloInput): Promise<RuntimeRef>;
  resumeSolo(ref: RuntimeRef, checkpoint: PhaseCheckpoint, idempotencyKey: string): Promise<RuntimeRef>;
  inspect(ref: RuntimeRef): Promise<RuntimeObservation>;
  recover?(key: string, runId?: string): Promise<RuntimeRef | undefined>;
  checkRun?(runId: string): Promise<OrcaDelivery>;
  ackRun?(runId: string, deliveryId: string): Promise<void>;
  retainWorker?(dispatchId: string): Promise<void>;
  releaseWorker?(dispatchId: string): Promise<void>;
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
  const worktree = effects.find(effect => effect.kind === 'worktree');
  return {
    runId: id(started.runId, 'Run ID'), taskId: id(started.taskId, 'Task ID'),
    dispatchId: id(started.dispatchId, 'Dispatch ID'), owner: 'lead', repoPath,
    terminal: typeof terminal?.id === 'string' ? terminal.id : undefined,
    ...(typeof worktree?.id === 'string' ? { worktreeId: worktree.id } : {})
  };
}

export function interpretWorkerShow(shown: Record<string, unknown>): RuntimeObservation['state'] {
  const dispatchStatus = object(shown.dispatch).status;
  if (dispatchStatus === 'completed' || dispatchStatus === 'failed') return 'settled';
  const liveness = object(object(shown.projection).liveness).verdict;
  return liveness === 'live' ? 'live' : 'unverifiable';
}

export class OrcaRuntime implements RuntimeAdapter {
  constructor(
    private readonly execute: (args: string[]) => Record<string, unknown> = runOrca,
    private readonly gitHead: (repoPath: string) => string = repoPath => execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  ) {}
  private readonly packageRuns = new Map<string, Promise<string>>();

  private listRuns(): Record<string, unknown>[] {
    const runs: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const args = ['orchestration', 'run-list'];
      if (cursor) args.push('--cursor', cursor);
      const page = this.execute(args);
      runs.push(...(Array.isArray(page.runs) ? page.runs : []).map(object));
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error('Orca Run pagination repeated its cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return runs;
  }

  private packageRun(repoPath: string, goalId: string, goalVersion: number): Promise<string> {
    const objective = `APOS package Run ${repoPath} ${goalId} goal v${goalVersion}`;
    let pending = this.packageRuns.get(objective);
    if (!pending) {
      pending = Promise.resolve().then(() => {
        const existing = this.listRuns().find(row => row.objective === objective);
        if (existing) return id(existing.id, 'Run ID');
        return id(object(this.execute(['orchestration', 'run-create', '--objective', objective]).run).id, 'Run ID');
      });
      this.packageRuns.set(objective, pending);
    }
    return pending;
  }

  private findRun(key: string): Record<string, unknown> | undefined {
    return this.listRuns().find(row => typeof row.objective === 'string' && row.objective.endsWith(`key ${key}`));
  }

  async startSolo(input: SoloInput): Promise<RuntimeRef> {
    this.execute(['repo', 'add', '--path', input.repoPath]);
    const run = this.execute(['orchestration', 'run-create', '--objective', `APOS ${input.goalId} proposal v${input.proposalVersion} key ${input.idempotencyKey}`]);
    const runId = id(object(run.run).id, 'Run ID');
    const spec = `Target: ${input.repoPath}, ${input.goalId}. Change: implement approved Solo Goal end to end. Constraints: read .apos/goals/${input.goalId}/goal.md and execution.md; preserve scope and user files; do not merge without authorization. Ownership: Lead owns Goal. Observable acceptance: tests and evidence for every Goal acceptance criterion. Write a concise committed report at .apos/goals/${input.goalId}/evidence/solo-v${input.proposalVersion}.md with commits, tests, decisions and Orca Run/Task/Dispatch IDs; include its path in worker_done. Follow the injected Orca preamble; report worker_done exactly once with explicit succeeded or failed outcome, then idle. APOS dispatch key: ${input.idempotencyKey}.`;
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--worktree', `path:${input.repoPath}`, '--agent', 'claude', '--run', runId]);
    const ref = extractStartedRef(started, input.repoPath);
    if (ref.runId !== runId) throw new Error('Orca worker belongs to an unexpected Run');
    return ref;
  }

  async startPackage(input: { package: WorkPackageSpec; repoPath: string; idempotencyKey: string }): Promise<PackageRuntimeRef> {
    const item = input.package;
    const baseCommit = this.gitHead(input.repoPath);
    if (!/^[0-9a-fA-F]{40,64}$/.test(baseCommit)) throw new Error('Full package base commit required');
    this.execute(['repo', 'add', '--path', input.repoPath]);
    const runId = await this.packageRun(input.repoPath, item.goalId, item.goalVersion);
    this.execute(['orchestration', 'run-use', '--id', runId]);
    const spec = `Target: ${input.repoPath}, ${item.goalId}, ${item.id}. Change: deliver ${item.outcome}. Constraints: read .apos/goals/${item.goalId}/goal.md, execution.md and packages/${item.id}.md; stay within scope; preserve other users' files; do not merge. Ownership: ${item.owner} owns this Work Package end to end. Observable acceptance: meet every local acceptance criterion, test, self-review, and report commit, diff and evidence. Write a concise committed report at .apos/goals/${item.goalId}/evidence/${item.id}-v${item.version}.md with commits, tests, decisions and Orca Run/Task/Dispatch IDs; include its path in worker_done. Follow the injected Orca preamble; report worker_done exactly once with explicit succeeded or failed outcome, then idle. APOS dispatch key: ${input.idempotencyKey}. APOS base commit: ${baseCommit}.`;
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--worktree', 'new-top-level', '--repo', `path:${input.repoPath}`, '--base-branch', 'HEAD', '--name', `apos-${item.goalId.toLowerCase()}-${item.id.toLowerCase()}-${input.idempotencyKey.slice(0, 8)}`, '--agent', 'claude', '--run', runId]);
    const ref = extractStartedRef(started, input.repoPath);
    if (ref.runId !== runId) throw new Error('Orca Worker belongs to an unexpected Run');
    return { ...ref, owner: 'worker', baseCommit };
  }

  async inspectPackage(ref: PackageRuntimeRef): Promise<'completed' | 'failed' | 'live' | 'unverifiable'> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId]);
    const status = object(shown.dispatch).status;
    if (status === 'completed' || status === 'failed') return status;
    const state = interpretWorkerShow(shown);
    return state === 'live' ? 'live' : 'unverifiable';
  }

  async resumePackage(input: { package: WorkPackageSpec; prior: PackageRuntimeRef; idempotencyKey: string }): Promise<PackageRuntimeRef> {
    const { prior, package: item } = input;
    if (!prior.terminal || !prior.worktreeId) throw new Error('Original Worker terminal and worktree required');
    this.execute(['orchestration', 'run-use', '--id', prior.runId]);
    const spec = `Target: ${prior.repoPath}, ${item.goalId}, ${item.id}. Continue the same package owner for contract v${item.version}. Read .apos/goals/${item.goalId}/packages/${item.id}.md; recheck all local acceptance and report fresh evidence. Follow the injected Orca preamble and report worker_done exactly once. APOS dispatch key: ${input.idempotencyKey}.${prior.baseCommit ? ` APOS base commit: ${prior.baseCommit}.` : ''}`;
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--terminal', prior.terminal, '--worktree', `id:${prior.worktreeId}`, '--run', prior.runId]);
    const ref = extractStartedRef(started, prior.repoPath);
    if (ref.runId !== prior.runId) throw new Error('Resumed Worker belongs to an unexpected Run');
    return { ...ref, owner: 'worker', worktreeId: ref.worktreeId ?? prior.worktreeId, baseCommit: prior.baseCommit };
  }

  async resumeSolo(ref: RuntimeRef, checkpoint: PhaseCheckpoint, idempotencyKey: string): Promise<RuntimeRef> {
    if (!ref.terminal) throw new Error('Orca terminal identity required to resume same owner');
    this.execute(['orchestration', 'run-use', '--id', ref.runId]);
    const spec = `Target: ${ref.repoPath}, APOS Solo Goal. Continue the same owner from phase ${checkpoint.phase}. Progress: ${checkpoint.progress}. Evidence: ${checkpoint.evidenceRefs.join(', ')}. Keep the approved Goal contract and report verification evidence. Follow the injected Orca preamble and report worker_done exactly once. APOS dispatch key: ${idempotencyKey}.`;
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--terminal', ref.terminal, '--worktree', `path:${ref.repoPath}`, '--run', ref.runId]);
    const next = extractStartedRef(started, ref.repoPath);
    return { ...next, terminal: next.terminal ?? ref.terminal, worktreeId: next.worktreeId ?? ref.worktreeId };
  }

  async inspect(ref: RuntimeRef): Promise<RuntimeObservation> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId]);
    const status = object(shown.dispatch).status;
    return { state: interpretWorkerShow(shown), ...(status === 'completed' || status === 'failed' ? { outcome: status } : {}), ref };
  }

  async checkRun(runId: string): Promise<OrcaDelivery> {
    this.execute(['orchestration', 'run-use', '--id', runId]);
    const result = this.execute(['orchestration', 'check', '--run', runId]);
    return {
      deliveryId: typeof result.deliveryId === 'string' ? result.deliveryId : undefined,
      messages: Array.isArray(result.messages) ? result.messages.map(value => object(value) as OrcaMessage) : []
    };
  }

  async ackRun(runId: string, deliveryId: string): Promise<void> {
    this.execute(['orchestration', 'run-use', '--id', runId]);
    const result = this.execute(['orchestration', 'check', '--run', runId, '--ack', deliveryId]);
    if (result.acknowledged !== deliveryId) throw new Error('Orca did not acknowledge the expected Delivery');
  }

  async retainWorker(dispatchId: string): Promise<void> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const status = object(shown.dispatch).status;
    if (status !== 'completed' && status !== 'failed') throw new Error('Orca Worker must settle before retention');
    const resource = object(shown.terminalResource);
    if (resource.releaseState === 'retained' || resource.ownershipState === 'retained') return;
    this.execute(['orchestration', 'worker-retain', '--dispatch', dispatchId]);
  }

  async releaseWorker(dispatchId: string): Promise<void> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const status = object(shown.dispatch).status;
    if (status !== 'completed' && status !== 'failed') throw new Error('Orca Worker must settle before release');
    this.execute(['orchestration', 'worker-release', '--dispatch', dispatchId]);
  }

  async recover(key: string, knownRunId?: string): Promise<RuntimeRef | undefined> {
    const run = knownRunId ? { id: knownRunId } : this.findRun(key);
    if (!run) return undefined;
    const runId = id(run.id, 'Run ID');
    const tasks = this.execute(['orchestration', 'task-list', '--run', runId]);
    const task = (Array.isArray(tasks.tasks) ? tasks.tasks : []).map(object).find(row => typeof row.spec === 'string' && row.spec.includes(`APOS dispatch key: ${key}.`));
    if (!task) return undefined;
    const taskId = id(task.id, 'Task ID');
    const detail = this.execute(['orchestration', 'dispatch-show', '--task', taskId]);
    const dispatch = object(detail.dispatch);
    if (!dispatch.id) return undefined;
    const match = /Target: (.*?), (?:GOAL-[A-Z0-9-]+\.|APOS Solo Goal\.)/.exec(String(task.spec));
    if (!match) throw new Error('Orca task has no APOS repo path');
    return { runId, taskId, dispatchId: id(dispatch.id, 'Dispatch ID'), owner: 'lead', repoPath: match[1], terminal: typeof dispatch.assignee_handle === 'string' ? dispatch.assignee_handle : undefined };
  }

  async recoverPackage(key: string, knownRunId?: string): Promise<PackageRuntimeRef | undefined> {
    let runId: string | undefined;
    let task: Record<string, unknown> | undefined;
    const candidates = knownRunId ? [{ id: knownRunId }] : this.listRuns().filter(row => typeof row.objective === 'string' && (row.objective.includes('APOS package Run ') || row.objective.endsWith(`key ${key}`)));
    for (const candidate of candidates) {
      const candidateId = id(candidate.id, 'Run ID');
      const tasks = this.execute(['orchestration', 'task-list', '--run', candidateId]);
      task = (Array.isArray(tasks.tasks) ? tasks.tasks : []).map(object).find(row => typeof row.spec === 'string' && row.spec.includes(`APOS dispatch key: ${key}.`));
      if (task) { runId = candidateId; break; }
    }
    if (!task || !runId) return undefined;
    const taskId = id(task.id, 'Task ID');
    const detail = this.execute(['orchestration', 'dispatch-show', '--task', taskId]);
    const dispatch = object(detail.dispatch);
    if (!dispatch.id) return undefined;
    const match = /Target: (.*?), (GOAL-[A-Z0-9-]+), (WP-[A-Z0-9-]+)\./.exec(String(task.spec));
    if (!match) throw new Error('Orca task has no APOS package target');
    const dispatchId = id(dispatch.id, 'Dispatch ID');
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const worker = object(shown.worker);
    const baseCommit = /APOS base commit: ([0-9a-fA-F]{40,64})\./.exec(String(task.spec))?.[1];
    return { runId, taskId, dispatchId, owner: 'worker', repoPath: match[1], terminal: typeof dispatch.assignee_handle === 'string' ? dispatch.assignee_handle : undefined, worktreeId: typeof worker.worktreeId === 'string' ? worker.worktreeId : undefined, ...(baseCommit ? { baseCommit } : {}) };
  }
}
