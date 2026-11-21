import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhaseCheckpoint } from '../../domain/contracts.js';
import type { WorkPackageSpec } from '../../domain/packages.js';
import { quotaMessage, unsentBrief } from '../screens.js';
import { DEFAULT_PROFILES, committedFileDigest, leadBrief, oneLine, parseRepoMarker, repairBrief } from '../brief.js';
import type {
  Budget,
  LaunchReceipt,
  PackageRuntimeRef,
  ReviewerRef,
  Role,
  RuntimeProfile,
  RuntimeProfiles,
  RuntimeRef,
} from '../../domain/runtime-refs.js';
import type {
  HandoffInput,
  LeadInput,
  OrcaDelivery,
  OrcaMessage,
  PackageRuntime,
  RuntimeAdapter,
  BotIdentity,
  BotWakeInput,
  RuntimeObservation,
  WakeInput,
} from '../../ports/runtime.js';
import { COMPACT, SPILL_LIMIT, launchArgs, listRuns, runOrca, type OrcaContext } from './exec.js';
import { handoff, startReviewer, wakeLead } from './handoff.js';
import { callerBot, findBot, mailBot, wakeBot } from './bots.js';
import { inspectPackage, recoverPackage, resumePackage, startPackage } from './packages.js';
import {
  assigneeOf,
  extractStartedRef,
  id,
  idleMinutesFrom,
  interpretWorkerShow,
  messagesOf,
  object,
  profileChanged,
  runIdOf,
  worktreePath,
} from './parse.js';

export class OrcaRuntime implements RuntimeAdapter, PackageRuntime {
  constructor(
    private readonly execute: (args: string[]) => Record<string, unknown> = runOrca,
    private readonly gitHead: (repoPath: string) => string = repoPath =>
      execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    private readonly profiles: RuntimeProfiles | (() => RuntimeProfiles) = DEFAULT_PROFILES,
    private readonly fileDigest: (repoPath: string, commit: string, path: string) => string = committedFileDigest,
    /** Where long brief text is written instead of being pasted (`<controller home>/notes`). */
    private readonly noteDir?: () => string,
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
  profile(role: Role): RuntimeProfile {
    return (typeof this.profiles === 'function' ? this.profiles() : this.profiles)[role];
  }
  private readonly packageRuns = new Map<string, Promise<string>>();

  /** What the extracted package and handoff modules use from this runtime; built per call over the same instance state. */
  private get context(): OrcaContext {
    return {
      execute: args => this.execute(args),
      gitHead: repoPath => this.gitHead(repoPath),
      fileDigest: (repoPath, commit, path) => this.fileDigest(repoPath, commit, path),
      profile: role => this.profile(role),
      spill: (text, key) => this.spill(text, key),
      packageRuns: this.packageRuns,
      handoff: input => this.handoff(input),
      recover: (key, knownRunId) => this.recover(key, knownRunId),
    };
  }

  private findRun(key: string): Record<string, unknown> | undefined {
    return listRuns(args => this.execute(args)).find(
      row => typeof row.objective === 'string' && row.objective.endsWith(`key ${key}`),
    );
  }

  async startLead(input: LeadInput): Promise<RuntimeRef> {
    this.execute(['repo', 'add', '--path', input.repoPath]);
    const run = this.execute([
      'orchestration',
      'run-create',
      '--objective',
      `APOS ${input.goalId} lead v${input.goalVersion} key ${input.idempotencyKey}`,
    ]);
    const runId = runIdOf(run);
    // The Lead runs in its own worktree from an exact base commit, never in the managed checkout, and keeps it as the Solo owner.
    const baseCommit = this.gitHead(input.repoPath);
    if (!/^[0-9a-fA-F]{40,64}$/.test(baseCommit)) throw new Error('Full Lead base commit required');
    const spec = leadBrief({
      repoPath: input.repoPath,
      goalId: input.goalId,
      goalVersion: input.goalVersion,
      baseCommit,
      idempotencyKey: input.idempotencyKey,
      budget: input.budget,
      digest: path => this.fileDigest(input.repoPath, baseCommit, path),
    });
    const profile = this.profile('lead');
    const started = this.execute([
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
      `apos-${input.goalId.toLowerCase()}-lead-${input.idempotencyKey.slice(0, 8)}`,
      ...launchArgs(profile),
      '--run',
      runId,
    ]);
    const ref = extractStartedRef(started, input.repoPath);
    if (ref.runId !== runId) throw new Error('Orca Lead belongs to an unexpected Run');
    return { ...ref, baseCommit, requested: profile };
  }

  startPackage(input: {
    package: WorkPackageSpec;
    repoPath: string;
    idempotencyKey: string;
    dependencyCommits?: string[];
  }): Promise<PackageRuntimeRef> {
    return startPackage(this.context, input);
  }

  inspectPackage(ref: PackageRuntimeRef): Promise<'completed' | 'failed' | 'live' | 'unverifiable'> {
    return inspectPackage(this.context, ref);
  }

  resumePackage(input: {
    package: WorkPackageSpec;
    prior: PackageRuntimeRef;
    idempotencyKey: string;
    finding?: string;
    attempt?: number;
    dependencyCommits?: string[];
  }): Promise<PackageRuntimeRef> {
    return resumePackage(this.context, input);
  }

  async resumeSolo(
    ref: RuntimeRef,
    checkpoint: PhaseCheckpoint,
    idempotencyKey: string,
    budget?: Budget,
  ): Promise<RuntimeRef> {
    const goalId = /^GOAL-[A-Z0-9-]+$/.test(checkpoint.goalId ?? '') ? checkpoint.goalId! : 'GOAL';
    const finding = `${checkpoint.phase}: ${checkpoint.progress}${checkpoint.evidenceRefs.length ? `\nLogs: ${checkpoint.evidenceRefs.join(', ')}` : ''}`;
    // The Human changed the lead profile: a fresh agent on the same worktree, with the full owner brief and the finding.
    if (ref.worktreeId && ref.baseCommit && profileChanged(ref.requested, this.profile('lead'))) {
      return this.handoff({
        kind: 'solo-owner',
        role: 'lead',
        repoPath: ref.repoPath,
        goalId,
        runId: ref.runId,
        worktreeId: ref.worktreeId,
        baseCommit: ref.baseCommit,
        idempotencyKey,
        attempt: checkpoint.attempt ?? 2,
        fromAgent: ref.requested?.agent,
        extra: `The controller's finding on the last attempt: ${finding}`,
        budget,
      });
    }
    if (!ref.terminal) throw new Error('Orca terminal identity required to resume same owner');
    this.execute(['orchestration', 'run-use', '--id', ref.runId]);
    if (!ref.worktreeId) throw new Error('Solo owner worktree identity required to resume same owner');
    const spec = repairBrief({
      repoPath: ref.repoPath,
      goalId,
      attempt: checkpoint.attempt ?? 2,
      finding: this.spill(finding, idempotencyKey),
      idempotencyKey,
      baseCommit: ref.baseCommit,
      budget,
    });
    const started = this.execute([
      'orchestration',
      'worker-start',
      '--spec',
      spec,
      '--terminal',
      ref.terminal,
      '--worktree',
      `id:${ref.worktreeId}`,
      '--timeout-ms',
      '240000',
      '--run',
      ref.runId,
    ]);
    const next = extractStartedRef(started, ref.repoPath);
    return {
      ...next,
      terminal: next.terminal ?? ref.terminal,
      worktreeId: next.worktreeId ?? ref.worktreeId,
      baseCommit: ref.baseCommit,
      requested: ref.requested,
    };
  }

  async inspect(ref: RuntimeRef): Promise<RuntimeObservation> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId]);
    const status = object(shown.dispatch).status;
    let idleMinutes = idleMinutesFrom(shown);
    // The full record has no idle age; ask the concise view, only for a dispatch that has not settled.
    if (idleMinutes === undefined && status !== 'completed' && status !== 'failed') {
      try {
        idleMinutes = idleMinutesFrom(
          this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId, COMPACT]),
        );
      } catch {
        /* idle age is advisory */
      }
    }
    return {
      state: interpretWorkerShow(shown),
      ...(status === 'completed' || status === 'failed' ? { outcome: status } : {}),
      ...(idleMinutes !== undefined ? { idleMinutes } : {}),
      ref,
    };
  }

  /**
   * Reads the Run's unread mail without consuming it. Orca 1.4.265 marks a consuming check's batch handled and
   * gives no Delivery to ack, so mail the controller leaves pending must not be consumed: it comes back next tick.
   */
  async checkRun(runId: string): Promise<OrcaDelivery> {
    this.execute(['orchestration', 'run-use', '--id', runId]);
    return { messages: messagesOf(this.execute(['orchestration', 'check', '--run', runId, '--peek'])) };
  }

  async replyMessage(runId: string, messageId: string, body: string): Promise<void> {
    this.execute(['orchestration', 'reply', '--run', runId, '--id', messageId, '--body', oneLine(body)]);
  }

  /**
   * Consumes the Run's unread batch once the controller handled every message it read. Mail that arrived since
   * that read is not consumed: a fresh peek finds it and nothing is consumed this tick, so it all comes back on
   * the next read. Only mail landing between that peek and the consume is returned, consumed, for the caller to
   * handle now. Handled mail that is already gone (an empty batch) is not an error.
   */
  async ackRun(runId: string, handled: string[]): Promise<OrcaMessage[]> {
    this.execute(['orchestration', 'run-use', '--id', runId]);
    const seen = new Set(handled);
    const unseen = (rows: OrcaMessage[]) => rows.filter(item => !seen.has(item.id));
    if (unseen(messagesOf(this.execute(['orchestration', 'check', '--run', runId, '--peek']))).length) return [];
    return unseen(messagesOf(this.execute(['orchestration', 'check', '--run', runId])));
  }

  async retainWorker(dispatchId: string): Promise<void> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const status = object(shown.dispatch).status;
    if (status !== 'completed' && status !== 'failed') throw new Error('Orca Worker must settle before retention');
    const resource = object(shown.terminalResource);
    if (resource.releaseState === 'retained' || resource.ownershipState === 'retained') return;
    this.execute(['orchestration', 'worker-keep-open', '--dispatch', dispatchId]);
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
    } catch {
      /* fall through to what Orca now reports */
    }
    try {
      const status = object(this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]).dispatch).status;
      return status === 'completed' || status === 'failed' ? 'stopped' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  handoff(input: HandoffInput): Promise<RuntimeRef> {
    return handoff(this.context, input);
  }

  async deliveryHead(ref: { worktreeId?: string; dispatchId?: string }): Promise<string | undefined> {
    // The start receipt may omit the worktree effect; Orca's worker record is authoritative.
    const worktreeId =
      ref.worktreeId ??
      (ref.dispatchId
        ? (object(this.execute(['orchestration', 'worker-show', '--dispatch', ref.dispatchId]).worker).worktreeId as
            string | undefined)
        : undefined);
    const path = worktreePath(worktreeId);
    if (!path) return undefined;
    try {
      return this.gitHead(path);
    } catch {
      return undefined;
    }
  }

  async inputStalled(dispatchId: string): Promise<boolean> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const dispatch = object(shown.dispatch);
    const worker = object(shown.worker);
    // Seen live on a resume into a reused Codex terminal: status pending, stage turn_start_unobserved, brief still in the composer.
    return (
      ['dispatched', 'pending'].includes(String(dispatch.status)) &&
      !dispatch.lastHeartbeatAt &&
      ['input_accepted', 'turn_start_unobserved'].includes(String(worker.stage))
    );
  }

  private screen(terminal: string, dispatchId?: string): string[] {
    try {
      const tail = object(this.execute(['terminal', 'read', '--terminal', terminal, '--screen']).terminal).tail;
      if (Array.isArray(tail) && tail.length) return tail.map(String);
    } catch (error) {
      if (!dispatchId) throw error;
    }
    if (!dispatchId) return [];
    const read = this.execute(['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'auto']);
    if (Array.isArray(read.lines)) return read.lines.map(String);
    if (Array.isArray(object(read.terminal).tail)) return (object(read.terminal).tail as unknown[]).map(String);
    const raw =
      typeof read.output === 'string'
        ? read.output
        : typeof read.content === 'string'
          ? read.content
          : typeof object(read.worker).output === 'string'
            ? String(object(read.worker).output)
            : '';
    return raw ? raw.split(/\r?\n/) : [];
  }

  async composerPending(terminal: string, agent?: string): Promise<boolean> {
    return unsentBrief(agent, this.screen(terminal));
  }

  async agentQuota(terminal: string, agent?: string, dispatchId?: string): Promise<string | undefined> {
    return quotaMessage(agent, this.screen(terminal, dispatchId));
  }

  async nudge(terminal: string): Promise<void> {
    this.execute(['terminal', 'send', '--terminal', terminal, '--enter']);
  }

  async launchReceipt(dispatchId: string): Promise<LaunchReceipt | undefined> {
    const shown = this.execute(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const effective = object(object(object(object(shown.worker).startOptions).launch).effective);
    return Object.keys(effective).length
      ? {
          agent: effective.agent as string | undefined,
          model: effective.model as string | null | undefined,
          effort: effective.effort as string | null | undefined,
        }
      : undefined;
  }

  startReviewer(input: {
    repoPath: string;
    goalId: string;
    baseCommit: string;
    commit: string;
    reasons: string[];
    idempotencyKey: string;
    runId: string;
  }): Promise<ReviewerRef> {
    return startReviewer(this.context, input);
  }

  wakeLead(input: WakeInput): Promise<{ dispatchId: string; terminal?: string; requested?: RuntimeProfile }> {
    return wakeLead(this.context, input);
  }

  async recover(key: string, knownRunId?: string): Promise<RuntimeRef | undefined> {
    const run = knownRunId ? { id: knownRunId } : this.findRun(key);
    if (!run) return undefined;
    const runId = id(run.id, 'Run ID');
    const tasks = this.execute(['orchestration', 'task-list', '--run', runId]);
    const task = (Array.isArray(tasks.tasks) ? tasks.tasks : [])
      .map(object)
      .find(row => typeof row.spec === 'string' && row.spec.includes(`APOS dispatch key: ${key}.`));
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
    return {
      runId,
      taskId,
      dispatchId,
      owner: 'lead',
      repoPath: match[1],
      terminal: assigneeOf(dispatch, worker),
      ...(typeof worker.worktreeId === 'string' ? { worktreeId: worker.worktreeId } : {}),
      ...(baseCommit ? { baseCommit } : {}),
    };
  }

  findBot(nameOrId: string): BotIdentity | undefined {
    return findBot(args => this.execute(args), nameOrId);
  }

  callerBot(): BotIdentity | undefined {
    return callerBot(args => this.execute(args));
  }

  async wakeBot(input: BotWakeInput): Promise<{ messageId?: string }> {
    return wakeBot(args => this.execute(args), input);
  }

  async tellBot(bot: BotIdentity, subject: string, body: string): Promise<void> {
    mailBot(args => this.execute(args), bot, 'status', subject, body);
  }

  recoverPackage(key: string, knownRunId?: string): Promise<PackageRuntimeRef | undefined> {
    return recoverPackage(this.context, key, knownRunId);
  }
}
