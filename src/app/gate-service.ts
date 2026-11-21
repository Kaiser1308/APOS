import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newEvent } from './events.js';
import type { CommandCheck } from '../domain/contracts.js';
import {
  attemptKey,
  evaluateCommandCheck,
  extractFailures,
  protectedCheck,
  evaluateManualCheck,
  requiredChecks,
  sourceDigest,
  summarizeGate,
  type CheckResult,
  type CheckRun,
  type GateEnvironment,
  type GateReport,
} from '../domain/gate.js';
import { assertGitRoot } from '../store/project-history.js';
import { GitCommitInspector } from './integration.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import { untrustedProtectedFiles } from './protected-milestones.js';
import { ShellExecutor, type CommandExecutor } from './shell-executor.js';
import { GitWorktreeFactory, type WorkspaceFactory } from './gate-workspace.js';

export type { CommandExecutor, ExecResult } from './shell-executor.js';
export { ShellExecutor } from './shell-executor.js';
export type { Workspace, WorkspaceFactory } from './gate-workspace.js';
export { GitWorktreeFactory } from './gate-workspace.js';

/** sha256 of the committed source snapshot, or undefined when none is committed. */
export function committedSourceDigest(repoPath: string, goalId: string): string | undefined {
  try {
    const text = execFileSync('git', ['-C', assertGitRoot(repoPath), 'show', `HEAD:.apos/goals/${goalId}/source.md`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return sourceDigest(text);
  } catch {
    return undefined;
  }
}

export type GateOptions = {
  inspector?: CommitInspector;
  workspaces?: WorkspaceFactory;
  executor?: CommandExecutor;
  /** Logs live outside the managed repo so owners cannot edit or commit them. */
  artifactRoot?: string;
  sourceDigest?: (repoPath: string, goalId: string) => string | undefined;
  now?: () => string;
};

export class GateService {
  private readonly inspector: CommitInspector;
  private readonly workspaces: WorkspaceFactory;
  private readonly executor: CommandExecutor;
  private readonly artifactRoot: string;
  private readonly digest: (repoPath: string, goalId: string) => string | undefined;
  private readonly now: () => string;

  constructor(
    private readonly store: GoalRepository,
    options: GateOptions = {},
  ) {
    this.inspector = options.inspector ?? new GitCommitInspector();
    this.executor = options.executor ?? new ShellExecutor();
    this.workspaces = options.workspaces ?? new GitWorktreeFactory({ executor: this.executor });
    this.artifactRoot =
      options.artifactRoot ??
      process.env.APOS_ARTIFACTS ??
      store.artifactRoot?.() ??
      join(homedir(), '.apos', 'artifacts');
    this.digest =
      options.sourceDigest ??
      (store.currentSourceDigest
        ? (_repo: string, goalId: string) => store.currentSourceDigest!(goalId)
        : committedSourceDigest);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Reruns the Goal's checks on the merge commit, against the target head the merge was made on. */
  runPostMerge(goalId: string, repoPath: string): GateReport {
    const state = this.store.getGoal(goalId);
    if (state?.status !== 'verified' || !state.merge)
      throw new Error('Merged, verified Goal required for the post-merge gate');
    const parent = execFileSync('git', ['-C', assertGitRoot(repoPath), 'rev-parse', `${state.merge.mergeCommit}^1`], {
      encoding: 'utf8',
    }).trim();
    return this.execute(
      goalId,
      repoPath,
      { deliveryCommit: state.merge.mergeCommit, baseCommit: parent },
      'post-merge',
    );
  }

  /** Runs the Goal checks a package's acceptance names, on the package head against its own base. */
  runPackage(goalId: string, packageId: string, repoPath: string, head: string): GateReport {
    const state = this.store.getGoal(goalId);
    const item = state?.packages?.[packageId];
    if (!state || item?.status !== 'executing') throw new Error('Executing package required for package gate');
    const wanted = new Set(item.spec.acceptance.flatMap(criterion => criterion.checkIds ?? []));
    const base = item.runtimeRef?.baseCommit;
    if (!base) throw new Error('Package base commit unknown');
    if (!this.inspector.contains(repoPath, base, head))
      throw new Error('Package head does not descend from its base commit');
    const artifacts = join(this.artifactRoot, goalId, `${packageId}-${randomUUID()}`);
    mkdirSync(artifacts, { recursive: true });
    const checks: CheckResult[] = state.spec.checks
      .filter(check => wanted.has(check.id))
      .map(check => {
        if (check.kind === 'manual') return evaluateManualCheck(check, head, state.manualConfirmations ?? []);
        const baseRuns =
          check.expect === 'no-new-failures' ? this.runMany(check, repoPath, base, 'base', artifacts) : [];
        return this.evaluate(check, repoPath, head, baseRuns, artifacts);
      });
    const missingDependencies = item.spec.dependencies.filter(dep => {
      const dependency = state.packages?.[dep];
      const commit = dependency?.gate?.deliveryCommit ?? dependency?.evidence.at(-1)?.commitRef;
      return dependency?.status !== 'verified' || !commit || !this.inspector.contains(repoPath, commit, head);
    });
    if (missingDependencies.length)
      checks.push({
        checkId: 'APOS-DEPENDENCIES',
        status: 'fail',
        reason: `delivery does not contain verified dependency commits: ${missingDependencies.join(', ')}`,
        base: [],
        delivery: [],
        newFailures: [],
      });
    const changedFiles = this.inspector.files(repoPath, head, base);
    const guard = protectedCheck(goalId, changedFiles);
    if (guard) checks.push(guard);
    const report: GateReport = {
      gateId: `GATE-${randomUUID()}`,
      goalId,
      goalVersion: state.spec.version,
      sourceSha256: state.spec.source.sha256,
      baseCommit: base,
      deliveryCommit: head,
      attemptKey: `${item.spec.id}@${item.spec.version}:${item.attempts}`,
      phase: 'delivery',
      changedFiles,
      environment: { platform: process.platform, shell: this.executor.shell, node: process.version },
      checks,
      result: summarizeGate(checks),
      at: this.now(),
    };
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    this.store.append(
      newEvent(
        goalId,
        'package-gate-recorded',
        {
          packageId,
          report,
          signature: checks
            .filter(c => c.status !== 'pass')
            .map(c => `${c.checkId}[${c.newFailures.join(',')}]`)
            .sort()
            .join('|'),
        },
        this.now(),
      ),
    );
    return report;
  }

  run(goalId: string, repoPath: string, input: { deliveryCommit: string; baseCommit?: string }): GateReport {
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing') throw new Error('Executing Goal required for gate');
    return this.execute(goalId, repoPath, input, 'delivery');
  }

  private execute(
    goalId: string,
    repoPath: string,
    input: { deliveryCommit: string; baseCommit?: string },
    phase: 'delivery' | 'post-merge',
  ): GateReport {
    const state = this.store.getGoal(goalId)!;
    const current = this.digest(repoPath, goalId);
    if (current !== state.spec.source.sha256)
      throw new Error('Source snapshot changed or missing since approval; revise the Goal before gating');
    if (
      phase === 'delivery' &&
      state.proposal?.mode === 'multi-wp' &&
      input.baseCommit &&
      input.baseCommit.toLowerCase() !== state.proposal.baseCommit?.toLowerCase()
    )
      throw new Error('Multi-WP integration gate must use the proposal base commit');
    const baseCommit =
      input.baseCommit ??
      (state.proposal?.mode === 'multi-wp'
        ? state.proposal.baseCommit
        : (state.runtimeRef?.baseCommit ?? state.proposal?.baseCommit));
    if (!baseCommit) throw new Error('Base commit unknown; record it in the proposal or pass --base');
    for (const [label, ref] of [
      ['base', baseCommit],
      ['delivery', input.deliveryCommit],
    ] as const) {
      if (!this.inspector.exists(repoPath, ref))
        throw new Error(`Full ${label} commit required and must exist: ${ref}`);
    }
    if (!this.inspector.contains(repoPath, baseCommit, input.deliveryCommit))
      throw new Error('Delivery commit does not descend from the base commit');

    const attempt = attemptKey(state);
    const gateId = `GATE-${randomUUID()}`;
    const artifacts = join(this.artifactRoot, goalId, gateId);
    mkdirSync(artifacts, { recursive: true });
    const checks: CheckResult[] = requiredChecks(state.spec).map(check => {
      if (check.kind === 'manual')
        return evaluateManualCheck(check, input.deliveryCommit, state.manualConfirmations ?? []);
      const base =
        check.expect === 'no-new-failures' ? this.runMany(check, repoPath, baseCommit, 'base', artifacts) : [];
      return this.evaluate(check, repoPath, input.deliveryCommit, base, artifacts);
    });
    const environment: GateEnvironment = {
      platform: process.platform,
      shell: this.executor.shell,
      node: process.version,
    };
    const changedFiles = this.inspector.files(repoPath, input.deliveryCommit, baseCommit);
    // After a merge the target legitimately carries APOS milestone commits; the guard applies to deliveries.
    const guard =
      phase === 'delivery'
        ? protectedCheck(
            goalId,
            untrustedProtectedFiles(this.store, goalId, repoPath, input.deliveryCommit, changedFiles),
          )
        : undefined;
    if (guard) checks.push(guard);
    const report: GateReport = {
      gateId,
      goalId,
      goalVersion: state.spec.version,
      sourceSha256: state.spec.source.sha256,
      baseCommit,
      deliveryCommit: input.deliveryCommit,
      attemptKey: attempt,
      phase,
      changedFiles,
      environment,
      checks,
      result: summarizeGate(checks),
      at: this.now(),
    };
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    this.store.append(newEvent(goalId, 'gate-recorded', report, this.now()));
    return report;
  }

  confirmManual(goalId: string, input: { checkId: string; deliveryCommit: string; by: string; note: string }): void {
    const state = this.store.getGoal(goalId);
    const owner = state?.runtimeRef?.owner;
    if (owner && input.by.trim().toLowerCase() === owner.toLowerCase())
      throw new Error('Manual check must be confirmed by someone other than the owner');
    this.store.append(newEvent(goalId, 'check-confirmed', input, this.now()));
  }

  /**
   * Seen live: two gates ran the same commit at once and one saw a new failure the other did not
   * (test_run_with_callback), which sent the owner to fix nothing. A new failure counts only if it
   * reproduces on one fresh delivery rerun.
   */
  private evaluate(
    check: CommandCheck,
    repoPath: string,
    commit: string,
    base: CheckRun[],
    artifacts: string,
  ): CheckResult {
    const first = evaluateCommandCheck(check, base, this.runMany(check, repoPath, commit, 'delivery', artifacts));
    if (first.status !== 'fail' || check.expect !== 'no-new-failures' || !first.newFailures.length) return first;
    const [again] = this.runMany({ ...check, runs: 1 }, repoPath, commit, 'recheck', artifacts);
    const seen = new Set(again && !again.timedOut ? again.failures : first.newFailures);
    const persistent = first.newFailures.filter(item => seen.has(item));
    const delivery = again ? [...first.delivery, again] : first.delivery;
    if (persistent.length)
      return {
        ...first,
        delivery,
        newFailures: persistent,
        reason: `${persistent.length} new failure(s) vs base, reproduced on recheck`,
      };
    return {
      ...first,
      delivery,
      status: 'pass',
      newFailures: [],
      reason: `new failure(s) did not reproduce on recheck (flaky): ${first.newFailures.join(', ')}`,
    };
  }

  private runMany(
    check: CommandCheck,
    repoPath: string,
    commit: string,
    role: 'base' | 'delivery' | 'recheck',
    artifacts: string,
  ): CheckRun[] {
    const runs: CheckRun[] = [];
    for (let n = 1; n <= check.runs; n++) {
      const workspace = this.workspaces.checkout(repoPath, commit);
      try {
        const result = this.executor.run(check.command, workspace.path, check.env, check.timeoutMs);
        const log = `$ ${check.command}\n# commit ${commit} (${role} run ${n}), shell ${this.executor.shell}\n${workspace.preparation ? `${workspace.preparation}\n` : ''}${result.output}\n# exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}\n`;
        const logRef = join(artifacts, `${check.id}-${role}-${n}.log`);
        writeFileSync(logRef, log);
        runs.push({
          commit,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          logRef,
          logSha256: createHash('sha256').update(log).digest('hex'),
          failures: extractFailures(result.output, check.failurePattern),
        });
      } finally {
        workspace.dispose();
      }
    }
    return runs;
  }
}
