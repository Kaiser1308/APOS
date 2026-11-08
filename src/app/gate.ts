import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandCheck } from '../domain/contracts.js';
import { attemptKey, evaluateCommandCheck, extractFailures, protectedCheck, evaluateManualCheck, requiredChecks, sourceDigest, summarizeGate, type CheckResult, type CheckRun, type GateEnvironment, type GateReport } from '../domain/gate.js';
import type { GoalRepository } from '../store/journal.js';
import { assertGitRoot } from '../store/project-history.js';
import { GitCommitInspector, type CommitInspector } from './integration.js';
import type { PackageRuntimeRef } from './packages.js';

export type ExecResult = { exitCode: number | null; timedOut: boolean; output: string };
export interface CommandExecutor {
  readonly shell: string;
  run(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): ExecResult;
}
export interface Workspace { readonly path: string; dispose(): void }
export interface WorkspaceFactory { checkout(repoPath: string, commit: string): Workspace }

const TIMEOUT_MARK = '[apos] check timed out; process tree killed';
/**
 * Runs the command in a child node process that owns the timeout. Killing only the shell would leave
 * grandchildren alive holding the workspace (seen on Windows), so the launcher kills the whole tree.
 */
const LAUNCHER = `
const { spawn, spawnSync } = require('child_process');
const command = process.argv[1], ms = Number(process.argv[2]), win = process.platform === 'win32';
const child = spawn(command, { shell: true, stdio: 'inherit', detached: !win, windowsHide: true });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (win) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}, ms);
child.on('exit', code => {
  clearTimeout(timer);
  if (timedOut) { process.stderr.write(${JSON.stringify(`\n${TIMEOUT_MARK}\n`)}); process.exit(124); }
  process.exit(code === null ? 1 : code);
});
`;

/** Runs through the platform's default shell; the shell is recorded so base and delivery provably match. */
export class ShellExecutor implements CommandExecutor {
  readonly shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  run(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): ExecResult {
    const result = spawnSync(process.execPath, ['-e', LAUNCHER, command, String(timeoutMs)], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs + 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const timedOut = (result.status === 124 && output.includes(TIMEOUT_MARK)) || (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return { exitCode: timedOut ? null : result.status, timedOut, output: `${output}${result.error && !timedOut ? `\n[apos] ${result.error.message}` : ''}` };
  }
}

/** A fresh detached Git worktree at exactly the requested commit, outside the managed repo. */
export class GitWorktreeFactory implements WorkspaceFactory {
  checkout(repoPath: string, commit: string): Workspace {
    const repo = assertGitRoot(repoPath);
    const full = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
    const path = mkdtempSync(join(tmpdir(), 'apos-gate-'));
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '--force', path, full], { stdio: 'ignore' });
    const head = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dispose = () => {
      try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', path], { stdio: 'ignore' }); }
      catch { rmSync(path, { recursive: true, force: true }); execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' }); }
    };
    if (head !== full) { dispose(); throw new Error(`Gate workspace is at ${head}, expected ${full}`); }
    return { path, dispose };
  }
}

/** sha256 of the committed source snapshot, or undefined when none is committed. */
export function committedSourceDigest(repoPath: string, goalId: string): string | undefined {
  try {
    const text = execFileSync('git', ['-C', assertGitRoot(repoPath), 'show', `HEAD:.apos/goals/${goalId}/source.md`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return sourceDigest(text);
  } catch { return undefined; }
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

  constructor(private readonly store: GoalRepository, options: GateOptions = {}) {
    this.inspector = options.inspector ?? new GitCommitInspector();
    this.workspaces = options.workspaces ?? new GitWorktreeFactory();
    this.executor = options.executor ?? new ShellExecutor();
    this.artifactRoot = options.artifactRoot ?? process.env.APOS_ARTIFACTS ?? store.artifactRoot?.() ?? join(homedir(), '.apos', 'artifacts');
    this.digest = options.sourceDigest ?? (store.currentSourceDigest ? (_repo: string, goalId: string) => store.currentSourceDigest!(goalId) : committedSourceDigest);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Reruns the Goal's checks on the merge commit, against the target head the merge was made on. */
  runPostMerge(goalId: string, repoPath: string): GateReport {
    const state = this.store.getGoal(goalId);
    if (state?.status !== 'verified' || !state.merge) throw new Error('Merged, verified Goal required for the post-merge gate');
    const parent = execFileSync('git', ['-C', assertGitRoot(repoPath), 'rev-parse', `${state.merge.mergeCommit}^1`], { encoding: 'utf8' }).trim();
    return this.execute(goalId, repoPath, { deliveryCommit: state.merge.mergeCommit, baseCommit: parent }, 'post-merge');
  }

  /** Runs the Goal checks a package's acceptance names, on the package head against its own base. */
  runPackage(goalId: string, packageId: string, repoPath: string, head: string): GateReport {
    const state = this.store.getGoal(goalId);
    const item = state?.packages?.[packageId];
    if (!state || item?.status !== 'executing') throw new Error('Executing package required for package gate');
    const wanted = new Set(item.spec.acceptance.flatMap(criterion => criterion.checkIds ?? []));
    const base = (item.runtimeRef as PackageRuntimeRef | undefined)?.baseCommit;
    if (!base) throw new Error('Package base commit unknown');
    if (!this.inspector.contains(repoPath, base, head)) throw new Error('Package head does not descend from its base commit');
    const artifacts = join(this.artifactRoot, goalId, `${packageId}-${randomUUID()}`);
    mkdirSync(artifacts, { recursive: true });
    const checks: CheckResult[] = state.spec.checks.filter(check => wanted.has(check.id)).map(check => {
      if (check.kind === 'manual') return evaluateManualCheck(check, head, state.manualConfirmations ?? []);
      const baseRuns = check.expect === 'no-new-failures' ? this.runMany(check, repoPath, base, 'base', artifacts) : [];
      return evaluateCommandCheck(check, baseRuns, this.runMany(check, repoPath, head, 'delivery', artifacts));
    });
    const changedFiles = this.inspector.files(repoPath, head, base);
    const guard = protectedCheck(goalId, changedFiles);
    if (guard) checks.push(guard);
    const report: GateReport = {
      gateId: `GATE-${randomUUID()}`, goalId, goalVersion: state.spec.version, sourceSha256: state.spec.source.sha256,
      baseCommit: base, deliveryCommit: head, attemptKey: `${item.spec.id}@${item.spec.version}:${item.attempts}`, phase: 'delivery',
      changedFiles,
      environment: { platform: process.platform, shell: this.executor.shell, node: process.version }, checks, result: summarizeGate(checks), at: this.now()
    };
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    this.store.append({ id: randomUUID(), goalId, type: 'package-gate-recorded', data: { packageId, report, signature: checks.filter(c => c.status !== 'pass').map(c => `${c.checkId}[${c.newFailures.join(',')}]`).sort().join('|') }, at: this.now() });
    return report;
  }

  run(goalId: string, repoPath: string, input: { deliveryCommit: string; baseCommit?: string }): GateReport {
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing') throw new Error('Executing Goal required for gate');
    return this.execute(goalId, repoPath, input, 'delivery');
  }

  private execute(goalId: string, repoPath: string, input: { deliveryCommit: string; baseCommit?: string }, phase: 'delivery' | 'post-merge'): GateReport {
    const state = this.store.getGoal(goalId)!;
    const current = this.digest(repoPath, goalId);
    if (current !== state.spec.source.sha256) throw new Error('Source snapshot changed or missing since approval; revise the Goal before gating');
    const packageBase = Object.values(state.packages ?? {}).map(item => (item.runtimeRef as PackageRuntimeRef | undefined)?.baseCommit).find(Boolean);
    // The commit the owner's worktree was created from is the truest base; the proposal's is a fallback.
    const baseCommit = input.baseCommit ?? (state.runtimeRef as { baseCommit?: string } | undefined)?.baseCommit ?? packageBase ?? state.proposal?.baseCommit;
    if (!baseCommit) throw new Error('Base commit unknown; record it in the proposal or pass --base');
    for (const [label, ref] of [['base', baseCommit], ['delivery', input.deliveryCommit]] as const) {
      if (!this.inspector.exists(repoPath, ref)) throw new Error(`Full ${label} commit required and must exist: ${ref}`);
    }
    if (!this.inspector.contains(repoPath, baseCommit, input.deliveryCommit)) throw new Error('Delivery commit does not descend from the base commit');

    const attempt = attemptKey(state);
    const gateId = `GATE-${randomUUID()}`;
    const artifacts = join(this.artifactRoot, goalId, gateId);
    mkdirSync(artifacts, { recursive: true });
    const checks: CheckResult[] = requiredChecks(state.spec).map(check => {
      if (check.kind === 'manual') return evaluateManualCheck(check, input.deliveryCommit, state.manualConfirmations ?? []);
      const base = check.expect === 'no-new-failures' ? this.runMany(check, repoPath, baseCommit, 'base', artifacts) : [];
      return evaluateCommandCheck(check, base, this.runMany(check, repoPath, input.deliveryCommit, 'delivery', artifacts));
    });
    const environment: GateEnvironment = { platform: process.platform, shell: this.executor.shell, node: process.version };
    const changedFiles = this.inspector.files(repoPath, input.deliveryCommit, baseCommit);
    // After a merge the target legitimately carries APOS milestone commits; the guard applies to deliveries.
    const guard = phase === 'delivery' ? protectedCheck(goalId, changedFiles) : undefined;
    if (guard) checks.push(guard);
    const report: GateReport = {
      gateId, goalId, goalVersion: state.spec.version, sourceSha256: state.spec.source.sha256,
      baseCommit, deliveryCommit: input.deliveryCommit, attemptKey: attempt, phase,
      changedFiles, environment, checks, result: summarizeGate(checks), at: this.now()
    };
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    this.store.append({ id: randomUUID(), goalId, type: 'gate-recorded', data: report, at: this.now() });
    return report;
  }

  confirmManual(goalId: string, input: { checkId: string; deliveryCommit: string; by: string; note: string }): void {
    const state = this.store.getGoal(goalId);
    const owner = (state?.runtimeRef as { owner?: string } | undefined)?.owner;
    if (owner && input.by.trim().toLowerCase() === owner.toLowerCase()) throw new Error('Manual check must be confirmed by someone other than the owner');
    this.store.append({ id: randomUUID(), goalId, type: 'check-confirmed', data: input, at: this.now() });
  }

  private runMany(check: CommandCheck, repoPath: string, commit: string, role: 'base' | 'delivery', artifacts: string): CheckRun[] {
    const runs: CheckRun[] = [];
    for (let n = 1; n <= check.runs; n++) {
      const workspace = this.workspaces.checkout(repoPath, commit);
      try {
        const result = this.executor.run(check.command, workspace.path, check.env, check.timeoutMs);
        const log = `$ ${check.command}\n# commit ${commit} (${role} run ${n}), shell ${this.executor.shell}\n${result.output}\n# exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}\n`;
        const logRef = join(artifacts, `${check.id}-${role}-${n}.log`);
        writeFileSync(logRef, log);
        runs.push({
          commit, exitCode: result.exitCode, timedOut: result.timedOut, logRef,
          logSha256: createHash('sha256').update(log).digest('hex'),
          failures: extractFailures(result.output, check.failurePattern)
        });
      } finally { workspace.dispose(); }
    }
    return runs;
  }
}

