import type { WorkPackageSpec } from '../../domain/packages.js';
import type { PackageRuntimeRef } from '../../domain/runtime-refs.js';
import { packageBrief, packageReportPath, parseRepoMarker, repoMarker } from '../brief.js';
import { OrcaRefused, launchArgs, listRuns, type OrcaContext } from './exec.js';
import { composeBase } from './git.js';
import { assigneeOf, extractStartedRef, id, interpretWorkerShow, object, profileChanged, runIdOf } from './parse.js';

export function packageRun(ctx: OrcaContext, repoPath: string, goalId: string, goalVersion: number): Promise<string> {
  const objective = `APOS package Run ${repoPath} ${goalId} goal v${goalVersion}`;
  let pending = ctx.packageRuns.get(objective);
  if (!pending) {
    pending = Promise.resolve().then(() => {
      const existing = listRuns(args => ctx.execute(args)).find(row => row.objective === objective);
      if (existing) return id(existing.id, 'Run ID');
      return runIdOf(ctx.execute(['orchestration', 'run-create', '--objective', objective]));
    });
    ctx.packageRuns.set(objective, pending);
  }
  return pending;
}

export async function startPackage(
  ctx: OrcaContext,
  input: {
    package: WorkPackageSpec;
    repoPath: string;
    idempotencyKey: string;
    dependencyCommits?: string[];
  },
): Promise<PackageRuntimeRef> {
  const item = input.package;
  const head = ctx.gitHead(input.repoPath);
  const baseCommit = input.dependencyCommits?.length
    ? composeBase(input.repoPath, head, input.dependencyCommits, item.id)
    : head;
  if (!/^[0-9a-fA-F]{40,64}$/.test(baseCommit)) throw new Error('Full package base commit required');
  ctx.execute(['repo', 'add', '--path', input.repoPath]);
  const runId = await packageRun(ctx, input.repoPath, item.goalId, item.goalVersion);
  ctx.execute(['orchestration', 'run-use', '--id', runId]);
  const spec = packageBrief({
    repoPath: input.repoPath,
    goalId: item.goalId,
    baseCommit,
    idempotencyKey: input.idempotencyKey,
    packageId: item.id,
    version: item.version,
    owner: item.owner,
    outcome: item.outcome,
    attempt: 1,
    contract: ctx.spill(JSON.stringify(item), `${input.idempotencyKey}-contract`),
    digest: path => ctx.fileDigest(input.repoPath, baseCommit, path),
  });
  const requested = ctx.profile('worker');
  const started = ctx.execute([
    'orchestration',
    'worker-start',
    '--spec',
    spec,
    '--worktree',
    'new-top-level',
    '--repo',
    `path:${input.repoPath}`,
    '--base-branch',
    baseCommit,
    '--name',
    `apos-${item.goalId.toLowerCase()}-${item.id.toLowerCase()}-${input.idempotencyKey.slice(0, 8)}`,
    ...launchArgs(requested),
    '--run',
    runId,
  ]);
  const ref = extractStartedRef(started, input.repoPath);
  if (ref.runId !== runId) throw new Error('Orca Worker belongs to an unexpected Run');
  return { ...ref, owner: 'worker', baseCommit, requested };
}

export async function inspectPackage(
  ctx: OrcaContext,
  ref: PackageRuntimeRef,
): Promise<'completed' | 'failed' | 'live' | 'unverifiable'> {
  const shown = ctx.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId]);
  const status = object(shown.dispatch).status;
  if (status === 'completed' || status === 'failed') return status;
  const state = interpretWorkerShow(shown);
  return state === 'live' ? 'live' : 'unverifiable';
}

export async function resumePackage(
  ctx: OrcaContext,
  input: {
    package: WorkPackageSpec;
    prior: PackageRuntimeRef;
    idempotencyKey: string;
    finding?: string;
    attempt?: number;
    dependencyCommits?: string[];
  },
): Promise<PackageRuntimeRef> {
  const { prior, package: item } = input;
  // The Human changed the worker profile: the new agent has no memory of this package, so it gets the full brief.
  if (prior.worktreeId && prior.baseCommit && profileChanged(prior.requested, ctx.profile('worker'))) {
    const ref = await ctx.handoff({
      kind: 'worker',
      role: 'worker',
      repoPath: prior.repoPath,
      goalId: item.goalId,
      goalVersion: item.goalVersion,
      runId: prior.runId,
      worktreeId: prior.worktreeId,
      baseCommit: prior.baseCommit,
      idempotencyKey: input.idempotencyKey,
      attempt: input.attempt ?? 2,
      fromAgent: prior.requested?.agent,
      packageId: item.id,
      packageVersion: item.version,
      owner: item.owner,
      outcome: item.outcome,
      packageContract: item,
      extra: [
        ...(input.finding
          ? [`The controller ran the package checks itself on the last commit. Its finding: ${input.finding}`]
          : []),
        ...(input.dependencyCommits?.length
          ? [
              `Integrate these verified dependency commits before working: ${input.dependencyCommits.join(', ')}. Their commits must be ancestors of your delivery.`,
            ]
          : []),
      ].join(' '),
    });
    return { ...ref, owner: 'worker' };
  }
  if (!prior.terminal || !prior.worktreeId) throw new Error('Original Worker terminal and worktree required');
  ctx.execute(['orchestration', 'run-use', '--id', prior.runId]);
  const spec = [
    `${item.goalId}, ${item.id}: continue the same package owner for contract v${item.version}, attempt ${input.attempt ?? 2}. Work only in your current working directory, your own worktree; never in the APOS repo.`,
    ...(input.finding
      ? [
          `The controller ran the package checks itself on your last commit. Its finding: ${ctx.spill(input.finding, input.idempotencyKey)}`,
        ]
      : []),
    ...(input.dependencyCommits?.length
      ? [
          `Integrate these verified dependency commits before working: ${input.dependencyCommits.join(', ')}. Their commits must be ancestors of your delivery.`,
        ]
      : []),
    `The current package contract from the controller supersedes any missing or older package document: ${ctx.spill(JSON.stringify(item), `${input.idempotencyKey}-contract`)}. Recheck all local acceptance under .apos/skills/_core/execute.md, and commit a new delivery report at ${packageReportPath(item.goalId, item.id, item.version, input.attempt ?? 2)} with the same activation line.`,
    'Follow the injected Orca preamble and report worker_done exactly once.',
    `${repoMarker(prior.repoPath)} APOS dispatch key: ${input.idempotencyKey}.${prior.baseCommit ? ` APOS base commit: ${prior.baseCommit}.` : ''}`,
  ].join(' ');
  let started: Record<string, unknown>;
  try {
    started = ctx.execute([
      'orchestration',
      'worker-start',
      '--spec',
      spec,
      '--terminal',
      prior.terminal,
      '--worktree',
      `id:${prior.worktreeId}`,
      '--timeout-ms',
      '240000',
      '--run',
      prior.runId,
    ]);
  } catch (error) {
    // Seen live: the old terminal had settled and Orca refused. Nothing was created, so the same owner continues
    // in a fresh terminal on the same worktree, which holds all of its work.
    if (!(error instanceof OrcaRefused)) throw error;
    started = ctx.execute([
      'orchestration',
      'worker-start',
      '--spec',
      spec,
      '--worktree',
      `id:${prior.worktreeId}`,
      ...launchArgs(ctx.profile('worker')),
      '--run',
      prior.runId,
    ]);
  }
  const ref = extractStartedRef(started, prior.repoPath);
  if (ref.runId !== prior.runId) throw new Error('Resumed Worker belongs to an unexpected Run');
  return {
    ...ref,
    owner: 'worker',
    worktreeId: ref.worktreeId ?? prior.worktreeId,
    baseCommit: prior.baseCommit,
    requested: prior.requested,
  };
}

export async function recoverPackage(
  ctx: OrcaContext,
  key: string,
  knownRunId?: string,
): Promise<PackageRuntimeRef | undefined> {
  let runId: string | undefined;
  let task: Record<string, unknown> | undefined;
  const candidates = knownRunId
    ? [{ id: knownRunId }]
    : listRuns(args => ctx.execute(args)).filter(
        row =>
          typeof row.objective === 'string' &&
          (row.objective.includes('APOS package Run ') || row.objective.endsWith(`key ${key}`)),
      );
  for (const candidate of candidates) {
    const candidateId = id(candidate.id, 'Run ID');
    const tasks = ctx.execute(['orchestration', 'task-list', '--run', candidateId]);
    task = (Array.isArray(tasks.tasks) ? tasks.tasks : [])
      .map(object)
      .find(row => typeof row.spec === 'string' && row.spec.includes(`APOS dispatch key: ${key}.`));
    if (task) {
      runId = candidateId;
      break;
    }
  }
  if (!task || !runId) return undefined;
  const taskId = id(task.id, 'Task ID');
  const detail = ctx.execute(['orchestration', 'dispatch-show', '--task', taskId]);
  const dispatch = object(detail.dispatch);
  if (!dispatch.id) return undefined;
  const repoPath = parseRepoMarker(String(task.spec));
  if (!repoPath || !/WP-[A-Z0-9-]+/.test(String(task.spec))) throw new Error('Orca task has no APOS package target');
  const match = [repoPath, repoPath];
  const dispatchId = id(dispatch.id, 'Dispatch ID');
  const shown = ctx.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
  const worker = object(shown.worker);
  const baseCommit = /APOS base commit: ([0-9a-fA-F]{40,64})\./.exec(String(task.spec))?.[1];
  return {
    runId,
    taskId,
    dispatchId,
    owner: 'worker',
    repoPath: match[1],
    terminal: assigneeOf(dispatch, worker),
    worktreeId: typeof worker.worktreeId === 'string' ? worker.worktreeId : undefined,
    ...(baseCommit ? { baseCommit } : {}),
  };
}
