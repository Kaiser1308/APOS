import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhaseCheckpoint } from '../domain/contracts.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import type { PackageRuntimeRef } from '../app/packages.js';
import { SCREENS, quotaMessage, unsentBrief } from './screens.js';
import { DEFAULT_PROFILES, committedFileDigest, handoffBrief, type HandoffKind, leadWakeBrief, oneLine, packageBrief, packageReportPath, parseRepoMarker, repoMarker, repairBrief, reviewBrief, leadBrief, type Budget, type Role, type RuntimeProfile, type RuntimeProfiles } from './brief.js';

export type RuntimeRef = { runId: string; taskId: string; dispatchId: string; owner: 'lead'; repoPath: string; terminal?: string; worktreeId?: string; baseCommit?: string; requested?: RuntimeProfile };
/** What Orca says actually launched; compared with the requested profile. */
export type LaunchReceipt = { agent?: string; model?: string | null; effort?: string | null };
export type ReviewerRef = { runId: string; taskId: string; dispatchId: string; owner: 'reviewer'; repoPath: string; terminal?: string; worktreeId?: string; key: string; commit: string; requested?: RuntimeProfile };
/** `idleMinutes`: how long Orca says the agent has been idle (worker-show `activity` + `lastActivity`), when it says. */
export type RuntimeObservation = { state: 'live' | 'settled' | 'unverifiable'; outcome?: 'completed' | 'failed'; idleMinutes?: number; ref: RuntimeRef };
export type OrcaMessage = { id: string; type: string; subject?: string; body?: string; payload?: unknown; dispatch_id?: string; dispatchId?: string };
export type OrcaDelivery = { deliveryId?: string; messages: OrcaMessage[] };
/** The Lead the controller dispatches when the Human selects a Goal; in Solo it is also the owner. */
export type HandoffInput = {
  kind: HandoffKind; role: Role; repoPath: string; goalId: string; goalVersion?: number; runId: string; worktreeId: string; baseCommit: string;
  idempotencyKey: string; attempt: number; fromAgent?: string; packageId?: string; packageVersion?: number; owner?: string; outcome?: string; extra?: string; budget?: Budget;
};
export type WakeInput = { repoPath: string; goalId: string; terminal: string; worktree: string; runId: string; events: string[]; idempotencyKey: string; phase?: 'plan' | 'multi'; requested?: { agent?: string; model?: string }; baseCommit?: string; goalVersion?: number };
/** True when the role's profile now names another agent or model than the dispatch runs; an unknown running profile is not a change. */
export function profileChanged(running: { agent?: string; model?: string } | undefined, wanted: RuntimeProfile): boolean {
  if (!running?.agent) return false;
  return running.agent !== wanted.agent || (running.model ?? undefined) !== (wanted.model ?? undefined);
}
export type LeadInput = { repoPath: string; goalId: string; goalVersion: number; idempotencyKey: string; budget?: Budget };
export interface RuntimeAdapter {
  startLead(input: LeadInput): Promise<RuntimeRef>;
  resumeSolo(ref: RuntimeRef, checkpoint: PhaseCheckpoint, idempotencyKey: string, budget?: Budget): Promise<RuntimeRef>;
  /** Replies to an owner's message on its Run. */
  replyMessage?(runId: string, messageId: string, body: string): Promise<void>;
  inspect(ref: RuntimeRef): Promise<RuntimeObservation>;
  recover?(key: string, runId?: string): Promise<RuntimeRef | undefined>;
  checkRun?(runId: string): Promise<OrcaDelivery>;
  ackRun?(runId: string, deliveryId: string): Promise<void>;
  retainWorker?(dispatchId: string): Promise<void>;
  releaseWorker?(dispatchId: string): Promise<void>;
  /** Head commit of the owner's worktree: the delivery the controller gates. */
  deliveryHead?(ref: { worktreeId?: string; dispatchId?: string }): Promise<string | undefined>;
  launchReceipt?(dispatchId: string): Promise<LaunchReceipt | undefined>;
  /** True when Orca accepted the input but the agent never started (no heartbeat, still at input_accepted). */
  inputStalled?(dispatchId: string): Promise<boolean>;
  /**
   * Reads the agent terminal: true when a brief sits unsubmitted in the composer and the agent is not
   * working. Orca's own stage was wrong both ways in the SQLFMT pilot, so the screen is the evidence.
   */
  composerPending?(terminal: string, agent?: string): Promise<boolean>;
  /** The agent's own out-of-quota line on its screen, read with that agent's rules (`screens.ts`). */
  agentQuota?(terminal: string, agent?: string): Promise<string | undefined>;
  /** Presses Enter once in the owner's terminal. */
  nudge?(terminal: string): Promise<void>;
  startReviewer?(input: { repoPath: string; goalId: string; baseCommit: string; commit: string; reasons: string[]; idempotencyKey: string; runId: string }): Promise<ReviewerRef>;
  /** Fences a dispatch and closes its agent; 'unknown' when Orca cannot confirm the agent stopped. */
  stopWorker?(dispatchId: string): Promise<'stopped' | 'unknown'>;
  /** A fresh agent with the role's current profile on an existing worktree and Run (`handoffBrief`). */
  handoff?(input: HandoffInput): Promise<RuntimeRef>;
  /** With `requested` and `baseCommit`, a changed lead profile wakes a fresh agent on the Lead worktree and returns its terminal. */
  wakeLead?(input: WakeInput): Promise<{ dispatchId: string; terminal?: string; requested?: RuntimeProfile }>;
}
/** The worktree a terminal lives in, so a Lead wake targets the Lead's own worktree even when it passed only `--terminal`. */
export function terminalWorktree(handle: string, execute: (args: string[]) => Record<string, unknown> = runOrca): string {
  const worktreeId = object(object(execute(['terminal', 'show', '--terminal', handle])).terminal).worktreeId;
  return `id:${id(worktreeId, 'terminal worktree')}`;
}

export const worktreePath = (worktreeId: string | undefined): string | undefined => worktreeId?.includes('::') ? worktreeId.slice(worktreeId.indexOf('::') + 2) : undefined;
// Codex can take over a minute to become ready; Orca's 60 s default reported a dispatch that did start as failed (seen live).
const launchArgs = (profile: RuntimeProfile): string[] => ['--timeout-ms', '240000', '--agent', profile.agent, ...(profile.model ? ['--model', profile.model] : []), ...(profile.model && profile.effort ? ['--effort', profile.effort] : [])];

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

/** Orca answered with an explicit error: the mutation did not happen, so retrying cannot duplicate it. */
export class OrcaRefused extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'OrcaRefused'; }
}

/** Orca refused because the session that owned the call has ended (its chat was closed); the call will never work, so the next step is a fresh agent. */
export const isDeadSession = (error: unknown): boolean => error instanceof OrcaRefused ? error.code === 'session_caller_not_live' : /[session_caller_not_live]/.test(error instanceof Error ? error.message : String(error));

// Orca 1.4.254 answers worker-show and worker-start with a concise view by default; APOS reads the full record.
const fullFlag = (args: string[]): string[] => args[0] === 'orchestration' && ['worker-show', 'worker-start'].includes(args[1] ?? '') && !args.includes('--full') ? ['--full'] : [];

/** `--compact` is APOS-internal: ask for Orca's concise view (the only one that carries `activity` and `lastActivity`) instead of the full record. */
export const COMPACT = '--compact';

function runOrca(argv: string[]): Record<string, unknown> {
  const compact = argv.includes(COMPACT);
  const args = argv.filter(item => item !== COMPACT);
  try {
    return parseOrcaResult(execFileSync('orca', [...args, ...(compact ? [] : fullFlag(args)), '--json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    let detail = '';
    try { const parsed = stdout ? JSON.parse(stdout) as { error?: { code?: string; message?: string }; result?: { state?: string; stage?: string; failedStage?: string } } : undefined; if (parsed?.error) detail = ` [${parsed.error.code}] ${parsed.error.message}`; else if (parsed?.result) detail = ` state=${parsed.result.state} stage=${parsed.result.stage ?? ''} failedStage=${parsed.result.failedStage ?? ''}`; } catch { detail = stdout ? ` ${stdout.slice(0, 500)}` : ''; }
    const code = /^ \[([a-z_]+)\]/.exec(detail)?.[1];
    const message = `Orca ${args[0]} ${args[1] ?? ''} failed:${detail || ` ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`}`;
    throw code ? new OrcaRefused(message, code) : new Error(message);
  }
}

/**
 * A package that depends on others must see their delivered code. Builds (without touching any checkout)
 * a commit whose parents are the repo head and the verified dependency commits, with their merged tree.
 */
export function composeBase(repoPath: string, head: string, commits: string[], packageId: string): string {
  const git = (args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'APOS', GIT_AUTHOR_EMAIL: 'apos@localhost', GIT_COMMITTER_NAME: 'APOS', GIT_COMMITTER_EMAIL: 'apos@localhost' } }).trim();
  let current = head;
  for (const commit of [...new Set(commits)]) {
    if (gitOk(repoPath, ['merge-base', '--is-ancestor', commit, current])) continue;
    const tree = git(['merge-tree', '--write-tree', current, commit]).split(/\r?\n/)[0];
    current = git(['commit-tree', tree, '-p', current, '-p', commit, '-m', `apos: base for ${packageId} with verified dependencies`]);
  }
  return current;
}

function gitOk(repoPath: string, args: string[]): boolean {
  try { execFileSync('git', ['-C', repoPath, ...args], { stdio: 'ignore' }); return true; } catch { return false; }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** run-create answers `{ run: { id } }` in older Orca and `{ runId }` in 1.4.254. */
function runIdOf(created: Record<string, unknown>): string {
  return id(created.runId ?? object(created.run).id, 'Run ID');
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Orca response missing ${label}`);
  return value;
}

export function extractStartedRef(started: Record<string, unknown>, repoPath: string): RuntimeRef {
  const effects = Array.isArray(started.effects) ? started.effects.map(object) : [];
  const terminal = effects.find(effect => effect.kind === 'terminal' && effect.role === 'agent');
  const worktree = effects.find(effect => effect.kind === 'worktree');
  const terminalId = typeof terminal?.id === 'string' ? terminal.id : typeof started.terminal === 'string' ? started.terminal : undefined;
  const worktreeId = typeof worktree?.id === 'string' ? worktree.id : typeof started.workspace === 'string' ? started.workspace : undefined;
  return {
    runId: id(started.runId, 'Run ID'), taskId: id(started.taskId, 'Task ID'),
    dispatchId: id(started.dispatchId, 'Dispatch ID'), owner: 'lead', repoPath,
    terminal: terminalId,
    ...(worktreeId ? { worktreeId } : {})
  };
}

export function interpretWorkerShow(shown: Record<string, unknown>): RuntimeObservation['state'] {
  const dispatchStatus = object(shown.dispatch).status;
  if (dispatchStatus === 'completed' || dispatchStatus === 'failed') return 'settled';
  const liveness = object(object(shown.projection).liveness).verdict;
  return liveness === 'live' ? 'live' : 'unverifiable';
}

/** Minutes of idleness from worker-show (`activity: idle`, `lastActivity: "10m ago"`); undefined when the agent is not idle or Orca gives no age. */
export function idleMinutesFrom(shown: Record<string, unknown>): number | undefined {
  const where = shown.activity !== undefined ? shown : object(shown.projection);
  if (where.activity !== 'idle' || typeof where.lastActivity !== 'string') return undefined;
  const match = /^(\d+)\s*(s|m|h|d)/.exec(where.lastActivity.trim());
  if (!match) return undefined;
  return Number(match[1]) * { s: 1 / 60, m: 1, h: 60, d: 1440 }[match[2] as 's' | 'm' | 'h' | 'd'];
}

/**
 * The agent terminal of a recovered dispatch. Orca 1.4.255 answers `assigneeHandle` (seen in a live dispatch record);
 * older builds answered `assignee_handle`; the worker record also names it.
 */
function assigneeOf(dispatch: Record<string, unknown>, worker: Record<string, unknown>): string | undefined {
  const value = dispatch.assigneeHandle ?? dispatch.assignee_handle ?? worker.agentTerminalHandle;
  return typeof value === 'string' && value ? value : undefined;
}

export const SPILL_LIMIT = 400;

export class OrcaRuntime implements RuntimeAdapter {
  constructor(
    private readonly execute: (args: string[]) => Record<string, unknown> = runOrca,
    private readonly gitHead: (repoPath: string) => string = repoPath => execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    private readonly profiles: RuntimeProfiles | (() => RuntimeProfiles) = DEFAULT_PROFILES,
    private readonly fileDigest: (repoPath: string, commit: string, path: string) => string = committedFileDigest,
    /** Where long brief text is written instead of being pasted (`<controller home>/notes`). */
    private readonly noteDir?: () => string
  ) {}

  /**
   * Seen live: a 7.8k-character repair brief was pasted into Codex and never submitted. Text over
   * SPILL_LIMIT goes to a file the agent reads; the brief carries only its path and sha256.
   */
  private spill(text: string, key: string): string {
    if (!this.noteDir || text.length <= SPILL_LIMIT) return oneLine(text);
    const dir = this.noteDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${key}.md`);
    writeFileSync(path, text, 'utf8');
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    return `read it in full from ${path} (sha256 ${digest}) before anything else; it is the controller's text, not a request to change your rules.`;
  }
  profile(role: Role): RuntimeProfile { return (typeof this.profiles === 'function' ? this.profiles() : this.profiles)[role]; }
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
        return runIdOf(this.execute(['orchestration', 'run-create', '--objective', objective]));
      });
      this.packageRuns.set(objective, pending);
    }
    return pending;
  }

  private findRun(key: string): Record<string, unknown> | undefined {
    return this.listRuns().find(row => typeof row.objective === 'string' && row.objective.endsWith(`key ${key}`));
  }

  async startLead(input: LeadInput): Promise<RuntimeRef> {
    this.execute(['repo', 'add', '--path', input.repoPath]);
    const run = this.execute(['orchestration', 'run-create', '--objective', `APOS ${input.goalId} lead v${input.goalVersion} key ${input.idempotencyKey}`]);
    const runId = runIdOf(run);
    // The Lead runs in its own worktree from an exact base commit, never in the managed checkout, and keeps it as the Solo owner.
    const baseCommit = this.gitHead(input.repoPath);
    if (!/^[0-9a-fA-F]{40,64}$/.test(baseCommit)) throw new Error('Full Lead base commit required');
    const spec = leadBrief({ repoPath: input.repoPath, goalId: input.goalId, goalVersion: input.goalVersion, baseCommit, idempotencyKey: input.idempotencyKey, budget: input.budget, digest: path => this.fileDigest(input.repoPath, baseCommit, path) });
    const profile = this.profile('lead');
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--worktree', 'new-top-level', '--repo', `path:${input.repoPath}`, '--base-branch', baseCommit, '--name', `apos-${input.goalId.toLowerCase()}-lead-${input.idempotencyKey.slice(0, 8)}`, ...launchArgs(profile), '--run', runId]);
    const ref = extractStartedRef(started, input.repoPath);
    if (ref.runId !== runId) throw new Error('Orca Lead belongs to an unexpected Run');
    return { ...ref, baseCommit, requested: profile };
  }

  async startPackage(input: { package: WorkPackageSpec; repoPath: string; idempotencyKey: string; dependencyCommits?: string[] }): Promise<PackageRuntimeRef> {
    const item = input.package;
    const head = this.gitHead(input.repoPath);
    const baseCommit = input.dependencyCommits?.length ? composeBase(input.repoPath, head, input.dependencyCommits, item.id) : head;
    if (!/^[0-9a-fA-F]{40,64}$/.test(baseCommit)) throw new Error('Full package base commit required');
    this.execute(['repo', 'add', '--path', input.repoPath]);
    const runId = await this.packageRun(input.repoPath, item.goalId, item.goalVersion);
    this.execute(['orchestration', 'run-use', '--id', runId]);
    const spec = packageBrief({ repoPath: input.repoPath, goalId: item.goalId, baseCommit, idempotencyKey: input.idempotencyKey, packageId: item.id, version: item.version, owner: item.owner, outcome: item.outcome, attempt: 1, digest: path => this.fileDigest(input.repoPath, baseCommit, path) });
    const requested = this.profile('worker');
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--worktree', 'new-top-level', '--repo', `path:${input.repoPath}`, '--base-branch', baseCommit, '--name', `apos-${item.goalId.toLowerCase()}-${item.id.toLowerCase()}-${input.idempotencyKey.slice(0, 8)}`, ...launchArgs(requested), '--run', runId]);
    const ref = extractStartedRef(started, input.repoPath);
    if (ref.runId !== runId) throw new Error('Orca Worker belongs to an unexpected Run');
    return { ...ref, owner: 'worker', baseCommit, requested };
  }

  async inspectPackage(ref: PackageRuntimeRef): Promise<'completed' | 'failed' | 'live' | 'unverifiable'> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId]);
    const status = object(shown.dispatch).status;
    if (status === 'completed' || status === 'failed') return status;
    const state = interpretWorkerShow(shown);
    return state === 'live' ? 'live' : 'unverifiable';
  }

  async resumePackage(input: { package: WorkPackageSpec; prior: PackageRuntimeRef; idempotencyKey: string; finding?: string; attempt?: number }): Promise<PackageRuntimeRef> {
    const { prior, package: item } = input;
    // The Human changed the worker profile: the new agent has no memory of this package, so it gets the full brief.
    if (prior.worktreeId && prior.baseCommit && profileChanged(prior.requested, this.profile('worker'))) {
      const ref = await this.handoff({ kind: 'worker', role: 'worker', repoPath: prior.repoPath, goalId: item.goalId, goalVersion: item.goalVersion, runId: prior.runId, worktreeId: prior.worktreeId, baseCommit: prior.baseCommit, idempotencyKey: input.idempotencyKey, attempt: input.attempt ?? 2, fromAgent: prior.requested?.agent, packageId: item.id, packageVersion: item.version, owner: item.owner, outcome: item.outcome, extra: input.finding ? `The controller ran the package checks itself on the last commit. Its finding: ${input.finding}` : undefined });
      return { ...ref, owner: 'worker' };
    }
    if (!prior.terminal || !prior.worktreeId) throw new Error('Original Worker terminal and worktree required');
    this.execute(['orchestration', 'run-use', '--id', prior.runId]);
    const spec = [
      `${item.goalId}, ${item.id}: continue the same package owner for contract v${item.version}, attempt ${input.attempt ?? 2}. Work only in your current working directory, your own worktree; never in the APOS repo.`,
      ...(input.finding ? [`The controller ran the package checks itself on your last commit. Its finding: ${this.spill(input.finding, input.idempotencyKey)}`] : []),
      `Read .apos/goals/${item.goalId}/packages/${item.id}.md, recheck all local acceptance under .apos/skills/_core/execute.md, and commit a new delivery report at ${packageReportPath(item.goalId, item.id, item.version, input.attempt ?? 2)} with the same activation line.`,
      'Follow the injected Orca preamble and report worker_done exactly once.',
      `${repoMarker(prior.repoPath)} APOS dispatch key: ${input.idempotencyKey}.${prior.baseCommit ? ` APOS base commit: ${prior.baseCommit}.` : ''}`
    ].join(' ');
    let started: Record<string, unknown>;
    try { started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--terminal', prior.terminal, '--worktree', `id:${prior.worktreeId}`, '--timeout-ms', '240000', '--run', prior.runId]); }
    catch (error) {
      // Seen live: the old terminal had settled and Orca refused. Nothing was created, so the same owner continues
      // in a fresh terminal on the same worktree, which holds all of its work.
      if (!(error instanceof OrcaRefused)) throw error;
      started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--worktree', `id:${prior.worktreeId}`, ...launchArgs(this.profile('worker')), '--run', prior.runId]);
    }
    const ref = extractStartedRef(started, prior.repoPath);
    if (ref.runId !== prior.runId) throw new Error('Resumed Worker belongs to an unexpected Run');
    return { ...ref, owner: 'worker', worktreeId: ref.worktreeId ?? prior.worktreeId, baseCommit: prior.baseCommit, requested: prior.requested };
  }

  async resumeSolo(ref: RuntimeRef, checkpoint: PhaseCheckpoint, idempotencyKey: string, budget?: Budget): Promise<RuntimeRef> {
    const goalId = /^GOAL-[A-Z0-9-]+$/.test(checkpoint.goalId ?? '') ? checkpoint.goalId! : 'GOAL';
    const finding = `${checkpoint.phase}: ${checkpoint.progress}${checkpoint.evidenceRefs.length ? `\nLogs: ${checkpoint.evidenceRefs.join(', ')}` : ''}`;
    // The Human changed the lead profile: a fresh agent on the same worktree, with the full owner brief and the finding.
    if (ref.worktreeId && ref.baseCommit && profileChanged(ref.requested, this.profile('lead'))) {
      return this.handoff({ kind: 'solo-owner', role: 'lead', repoPath: ref.repoPath, goalId, runId: ref.runId, worktreeId: ref.worktreeId, baseCommit: ref.baseCommit, idempotencyKey, attempt: checkpoint.attempt ?? 2, fromAgent: ref.requested?.agent, extra: `The controller's finding on the last attempt: ${finding}`, budget });
    }
    if (!ref.terminal) throw new Error('Orca terminal identity required to resume same owner');
    this.execute(['orchestration', 'run-use', '--id', ref.runId]);
    if (!ref.worktreeId) throw new Error('Solo owner worktree identity required to resume same owner');
    const spec = repairBrief({ repoPath: ref.repoPath, goalId, attempt: checkpoint.attempt ?? 2, finding: this.spill(finding, idempotencyKey), idempotencyKey, baseCommit: ref.baseCommit, budget });
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--terminal', ref.terminal, '--worktree', `id:${ref.worktreeId}`, '--timeout-ms', '240000', '--run', ref.runId]);
    const next = extractStartedRef(started, ref.repoPath);
    return { ...next, terminal: next.terminal ?? ref.terminal, worktreeId: next.worktreeId ?? ref.worktreeId, baseCommit: ref.baseCommit, requested: ref.requested };
  }

  async inspect(ref: RuntimeRef): Promise<RuntimeObservation> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId]);
    const status = object(shown.dispatch).status;
    let idleMinutes = idleMinutesFrom(shown);
    // The full record has no idle age; ask the concise view, only for a dispatch that has not settled.
    if (idleMinutes === undefined && status !== 'completed' && status !== 'failed') {
      try { idleMinutes = idleMinutesFrom(this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId, COMPACT])); } catch { /* idle age is advisory */ }
    }
    return { state: interpretWorkerShow(shown), ...(status === 'completed' || status === 'failed' ? { outcome: status } : {}), ...(idleMinutes !== undefined ? { idleMinutes } : {}), ref };
  }

  async checkRun(runId: string): Promise<OrcaDelivery> {
    this.execute(['orchestration', 'run-use', '--id', runId]);
    const result = this.execute(['orchestration', 'check', '--run', runId]);
    return {
      deliveryId: typeof result.deliveryId === 'string' ? result.deliveryId : undefined,
      messages: Array.isArray(result.messages) ? result.messages.map(value => object(value) as OrcaMessage) : []
    };
  }

  async replyMessage(runId: string, messageId: string, body: string): Promise<void> {
    this.execute(['orchestration', 'reply', '--run', runId, '--id', messageId, '--body', oneLine(body)]);
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

  /**
   * Fences a dispatch and closes its agent. Sure only when Orca says it closed the agent terminal, or the dispatch
   * reads settled afterwards (seen live: a stopped dispatch reads `failed`); anything else may still be running.
   */
  async stopWorker(dispatchId: string): Promise<'stopped' | 'unknown'> {
    try {
      const stopped = this.execute(['orchestration', 'worker-stop', '--dispatch', dispatchId]);
      if (stopped.processAction === 'closed_agent_terminal' || stopped.alreadySettled === true) return 'stopped';
    } catch { /* fall through to what Orca now reports */ }
    try {
      const status = object(this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]).dispatch).status;
      return status === 'completed' || status === 'failed' ? 'stopped' : 'unknown';
    } catch { return 'unknown'; }
  }

  /** Starts the role's current profile on an existing worktree and Run with a handoff brief: a fresh agent, never the old terminal. */
  async handoff(input: HandoffInput): Promise<RuntimeRef> {
    this.execute(['orchestration', 'run-use', '--id', input.runId]);
    const requested = this.profile(input.role);
    const spec = handoffBrief({ ...input, extra: input.extra ? this.spill(input.extra, input.idempotencyKey) : undefined, digest: path => this.fileDigest(input.repoPath, input.baseCommit, path) });
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--worktree', `id:${input.worktreeId}`, ...launchArgs(requested), '--run', input.runId]);
    const ref = extractStartedRef(started, input.repoPath);
    if (ref.runId !== input.runId) throw new Error('Handed-off agent belongs to an unexpected Run');
    return { ...ref, worktreeId: ref.worktreeId ?? input.worktreeId, baseCommit: input.baseCommit, requested };
  }

  async deliveryHead(ref: { worktreeId?: string; dispatchId?: string }): Promise<string | undefined> {
    // The start receipt may omit the worktree effect; Orca's worker record is authoritative.
    const worktreeId = ref.worktreeId ?? (ref.dispatchId ? object(this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId]).worker).worktreeId as string | undefined : undefined);
    const path = worktreePath(worktreeId);
    if (!path) return undefined;
    try { return this.gitHead(path); } catch { return undefined; }
  }

  async inputStalled(dispatchId: string): Promise<boolean> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const dispatch = object(shown.dispatch);
    const worker = object(shown.worker);
    // Seen live on a resume into a reused Codex terminal: status pending, stage turn_start_unobserved, brief still in the composer.
    return ['dispatched', 'pending'].includes(String(dispatch.status)) && !dispatch.lastHeartbeatAt && ['input_accepted', 'turn_start_unobserved'].includes(String(worker.stage));
  }

  private screen(terminal: string): string[] {
    const tail = object(this.execute(['terminal', 'read', '--terminal', terminal]).terminal).tail;
    return Array.isArray(tail) ? tail.map(String) : [];
  }

  async composerPending(terminal: string, agent?: string): Promise<boolean> {
    return unsentBrief(agent, this.screen(terminal));
  }

  async agentQuota(terminal: string, agent?: string): Promise<string | undefined> {
    return quotaMessage(agent, this.screen(terminal));
  }

  async nudge(terminal: string): Promise<void> {
    this.execute(['terminal', 'send', '--terminal', terminal, '--enter']);
  }

  async launchReceipt(dispatchId: string): Promise<LaunchReceipt | undefined> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const effective = object(object(object(object(shown.worker).startOptions).launch).effective);
    return Object.keys(effective).length ? { agent: effective.agent as string | undefined, model: effective.model as string | null | undefined, effort: effective.effort as string | null | undefined } : undefined;
  }

  /** A reviewer gets its own worktree at the gated commit and its own session; it never shares the owner's. */
  async startReviewer(input: { repoPath: string; goalId: string; baseCommit: string; commit: string; reasons: string[]; idempotencyKey: string; runId: string }): Promise<ReviewerRef> {
    this.execute(['orchestration', 'run-use', '--id', input.runId]);
    // Pin the reviewer skill at the base commit: the delivery under review must not choose its reviewer's rules.
    const spec = reviewBrief({ repoPath: input.repoPath, goalId: input.goalId, baseCommit: input.baseCommit, idempotencyKey: input.idempotencyKey, commit: input.commit, reasons: input.reasons, digest: path => this.fileDigest(input.repoPath, input.baseCommit, path) });
    const requested = this.profile('reviewer');
    const started = this.execute(['orchestration', 'worker-start', '--spec', spec, '--worktree', 'new-top-level', '--repo', `path:${input.repoPath}`, '--base-branch', input.commit, '--name', `apos-review-${input.goalId.toLowerCase()}-${input.idempotencyKey.slice(0, 8)}`, ...launchArgs(requested), '--run', input.runId]);
    const ref = extractStartedRef(started, input.repoPath);
    return { ...ref, owner: 'reviewer', key: input.idempotencyKey, commit: input.commit, requested };
  }

  async wakeLead(input: WakeInput): Promise<{ dispatchId: string; terminal?: string; requested?: RuntimeProfile }> {
    if (input.baseCommit && input.worktree.startsWith('id:') && profileChanged(input.requested, this.profile('lead'))) {
      // A fresh Lead started for this turn whose response was lost: found by its key, never started twice.
      const found = await this.recover(input.idempotencyKey, input.runId).catch(() => undefined);
      if (found) return { dispatchId: found.dispatchId, terminal: found.terminal, requested: this.profile('lead') };
      const events = input.events.map((item, index) => `(${index + 1}) ${item}`).join('\n');
      const ref = await this.handoff({ kind: input.phase === 'plan' ? 'lead-plan' : 'lead-multi', role: 'lead', repoPath: input.repoPath, goalId: input.goalId, goalVersion: input.goalVersion, runId: input.runId, worktreeId: input.worktree.slice(3), baseCommit: input.baseCommit, idempotencyKey: input.idempotencyKey, attempt: 1, fromAgent: input.requested?.agent, extra: `Events since the previous agent's last turn:\n${events}` });
      return { dispatchId: ref.dispatchId, terminal: ref.terminal, requested: ref.requested };
    }
    this.execute(['orchestration', 'run-use', '--id', input.runId]);
    const joined = input.events.map((item, index) => `(${index + 1}) ${item}`).join('\n');
    const events = joined.length > SPILL_LIMIT ? [`${input.events.length} events: ${this.spill(joined, input.idempotencyKey)}`] : input.events;
    const started = this.execute(['orchestration', 'worker-start', '--spec', leadWakeBrief({ ...input, events, phase: input.phase }), '--terminal', input.terminal, '--worktree', input.worktree, '--timeout-ms', '240000', '--run', input.runId]);
    return { dispatchId: id(started.dispatchId, 'Dispatch ID') };
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
    const repoPath = parseRepoMarker(String(task.spec));
    if (!repoPath) throw new Error('Orca task has no APOS repo path');
    const match = [repoPath, repoPath];
    const dispatchId = id(dispatch.id, 'Dispatch ID');
    const worker = object(this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]).worker);
    const baseCommit = /APOS base commit: ([0-9a-fA-F]{40,64})\./.exec(String(task.spec))?.[1];
    return { runId, taskId, dispatchId, owner: 'lead', repoPath: match[1], terminal: assigneeOf(dispatch, worker), ...(typeof worker.worktreeId === 'string' ? { worktreeId: worker.worktreeId } : {}), ...(baseCommit ? { baseCommit } : {}) };
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
    const repoPath = parseRepoMarker(String(task.spec));
    if (!repoPath || !/WP-[A-Z0-9-]+/.test(String(task.spec))) throw new Error('Orca task has no APOS package target');
    const match = [repoPath, repoPath];
    const dispatchId = id(dispatch.id, 'Dispatch ID');
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const worker = object(shown.worker);
    const baseCommit = /APOS base commit: ([0-9a-fA-F]{40,64})\./.exec(String(task.spec))?.[1];
    return { runId, taskId, dispatchId, owner: 'worker', repoPath: match[1], terminal: assigneeOf(dispatch, worker), worktreeId: typeof worker.worktreeId === 'string' ? worker.worktreeId : undefined, ...(baseCommit ? { baseCommit } : {}) };
  }
}

/** The Codex check behind `composerPending`, on the visible tail of a Codex TUI (see `screens.ts`). */
export function composerHasUnsentBrief(lines: string[]): boolean {
  return SCREENS.codex.unsentBrief(lines);
}
