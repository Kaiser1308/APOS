import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { LayerSpec } from '../domain/project-setup.js';
import type { ParsedReport, TestOutcome } from '../domain/results/index.js';
import { GitWorktreeFactory, type WorkspaceFactory } from './gate-workspace.js';
import { readToolReport } from './report-files.js';
import { ShellExecutor, type CommandExecutor, type ExecResult } from './shell-executor.js';

export type RunnerDeps = {
  /** Reports and logs go here, outside the repo. */
  artifactRoot: string;
  workspaces?: WorkspaceFactory;
  executor?: CommandExecutor;
  timeoutMs?: number;
};

const NOT_FOUND =
  /command not found|is not recognized as an internal or external command|executable file not found in \$PATH|: not found$/im;
/** Why a command did not run at all (timed out, never exited, not installed), or undefined when it ran. */
export const notRunnable = (result: ExecResult): string | undefined => {
  if (result.timedOut) return 'timed out';
  if (result.exitCode === null) return 'did not exit';
  if (result.exitCode === 127 || NOT_FOUND.test(result.output)) return 'command not found';
  return undefined;
};

/** Why a tool's exit code is not one its report may come with (`reportExitCodes`, default 0), or undefined when it is. */
export function reportExitProblem(exitCode: number | null, accepted: number[] | undefined): string | undefined {
  const allowed = accepted ?? [0];
  if (exitCode !== null && allowed.includes(exitCode)) return undefined;
  return `command exited ${exitCode ?? 'without an exit code'}; accepted report exit codes: ${allowed.join(', ')}`;
}

/** Runs tool commands in a clean worktree of a commit. */
export class ToolRunner {
  private readonly executor: CommandExecutor;
  private readonly workspaces: WorkspaceFactory;
  private readonly timeoutMs: number;
  private readonly artifactRoot: string;

  constructor(
    private readonly repo: string,
    deps: RunnerDeps,
  ) {
    this.executor = deps.executor ?? new ShellExecutor();
    this.workspaces = deps.workspaces ?? new GitWorktreeFactory({ executor: this.executor });
    this.timeoutMs = deps.timeoutMs ?? 600_000;
    this.artifactRoot = deps.artifactRoot;
  }

  /** One command of `tool` (its own, or a filled-in `runOne`) at `commit`, in the part's `root`. */
  run(
    commit: string,
    tool: LayerSpec,
    command: string,
    root: string,
    vars: { changed?: string } = {},
  ): { exec: ExecResult; report?: ParsedReport } {
    const workspace = this.workspaces.checkout(this.repo, commit);
    try {
      const dir = join(this.artifactRoot, 'runs', randomUUID());
      mkdirSync(dir, { recursive: true });
      const tempReport = join(dir, 'report').replaceAll('\\', '/');
      const apos = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
      const quotedApos = process.platform === 'win32' ? apos.replaceAll('"', '\\"') : apos.replace(/["\\$`]/g, '\\$&');
      const final = command
        .replaceAll('{report}', tempReport)
        .replaceAll('{changed}', vars.changed ?? '')
        .replaceAll('{apos}', quotedApos);
      const cwd = join(workspace.path, root);
      const exec = this.executor.run(final, cwd, {}, this.timeoutMs);
      if (!tool.format || tool.format === 'exit' || notRunnable(exec)) return { exec };
      const report = readToolReport({
        format: tool.format,
        command,
        report: tool.report,
        metric: tool.metric,
        cwd,
        tempReport,
      });
      return { exec, report };
    } finally {
      workspace.dispose();
    }
  }

  /**
   * Every tool of one layer of one part at `commit`, their tests merged. A tool that did not run, or whose report is
   * not a test report, is a problem: a missing run must never look like fewer tests.
   */
  layerTests(
    commit: string,
    part: string,
    root: string,
    layer: string,
    tools: LayerSpec[],
  ): { tests: TestOutcome[]; problems: string[]; processFailures: string[] } {
    const tests: TestOutcome[] = [];
    const problems: string[] = [];
    const processFailures: string[] = [];
    for (const tool of tools) {
      const { exec, report } = this.run(commit, tool, tool.command, root);
      const label = `${part}.${layer} ${tool.id}`;
      const unrunnable = notRunnable(exec);
      if (unrunnable) problems.push(`${label}: ${unrunnable}: ${tool.command}`);
      else if (!report || report.kind === 'unreadable')
        problems.push(`${label}: report unreadable: ${report?.kind === 'unreadable' ? report.reason : 'no report'}`);
      else if (report.kind !== 'tests') problems.push(`${label}: the tool does not report tests`);
      else {
        const reportedFailure = report.tests.some(test => test.status === 'fail' || test.status === 'error');
        if (exec.exitCode !== 0 && !reportedFailure)
          processFailures.push(`${label}: command exited ${exec.exitCode} without test failures in its report`);
        tests.push(...report.tests);
      }
    }
    return { tests, problems, processFailures };
  }
}
