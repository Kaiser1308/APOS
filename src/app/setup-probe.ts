import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { UserError } from '../domain/errors.js';
import { LAYER_IDS } from '../domain/layers.js';
import { parseProjectSetup, type LayerSpec } from '../domain/project-setup.js';
import type { ProbeResult, ProjectEvent } from '../domain/setup-history.js';
import { SETUP_FILE, type SetupCodec } from '../domain/setup-codec.js';
import type { TestOutcome } from '../domain/results/index.js';
import type { ProjectJournal } from '../store/journal.js';
import { assertGitRoot } from '../store/project-history.js';
import { GitWorktreeFactory, type WorkspaceFactory } from './gate-workspace.js';
import { ShellExecutor, type CommandExecutor } from './shell-executor.js';
import { ToolRunner, notRunnable } from './layer-runner.js';
import { fillRunOne } from '../domain/run-one.js';
import { loadFailure } from '../domain/results/load-errors.js';
import type { CatalogEntry } from '../domain/catalog.js';

export type ProbeDeps = {
  codec: SetupCodec;
  /** Reports and logs of the probe go here, outside the repo. */
  artifactRoot: string;
  workspaces?: WorkspaceFactory;
  executor?: CommandExecutor;
  timeoutMs?: number;
  /** The catalog, for each stack's `loadErrorPatterns`; without it only the "every test errored" rule applies. */
  catalog?: CatalogEntry[];
};
export type ProbeReport = { sha256: string; ok: boolean; results: ProbeResult[] };

/** The text of `.apos/project.yaml` as committed at `commit`. */
export function setupTextAt(repo: string, commit: string): string {
  try {
    return execFileSync('git', ['-C', assertGitRoot(repo), 'show', `${commit}:${SETUP_FILE}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new UserError(`${SETUP_FILE} does not exist at commit ${commit}: commit the setup first`);
  }
}

const signature = (tests: TestOutcome[]) =>
  JSON.stringify(tests.map(test => [test.id, test.status]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

/**
 * Runs every tool of the setup at `commit`, each in a clean worktree, and judges it by the probe rules:
 * the command runs; its report reads and (junit) holds tests; `runOne` runs exactly the one test asked for;
 * L1 and L2 give the same ids and statuses twice. A setup with no tool at all proves nothing and is not ok.
 */
export async function probeSetup(repo: string, commit: string, deps: ProbeDeps): Promise<ProbeReport> {
  const parsed = parseProjectSetup(setupTextAt(repo, commit), deps.codec);
  if (parsed.version !== 2) throw new UserError(`${SETUP_FILE} at ${commit} is not a v2 setup: nothing to probe`);
  const executor = deps.executor ?? new ShellExecutor();
  const workspaces = deps.workspaces ?? new GitWorktreeFactory({ executor });
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const results: ProbeResult[] = [];

  const runner = new ToolRunner(repo, {
    artifactRoot: join(deps.artifactRoot, 'probe'),
    workspaces,
    executor,
    timeoutMs,
  });
  const run = (tool: LayerSpec, command: string, root: string) => runner.run(commit, tool, command, root);

  const probeTool = (
    tool: LayerSpec,
    layer: string,
    root: string,
    patterns: string[],
  ): { ok: boolean; reason: string } => {
    const first = run(tool, tool.command, root);
    const problem = notRunnable(first.exec);
    if (problem) return { ok: false, reason: `${problem}: ${tool.command}` };
    const report = first.report;
    if (tool.format === 'exit')
      return { ok: true, reason: `runs (exit ${first.exec.exitCode}); only the exit code is read` };
    if (!report) return { ok: false, reason: 'no report was read' };
    if (report.kind === 'unreadable') return { ok: false, reason: `report unreadable: ${report.reason}` };
    if (tool.format === 'junit' && report.kind === 'tests' && !report.tests.length)
      return { ok: false, reason: 'the junit report holds no test' };
    const unloaded = report.kind === 'tests' ? loadFailure(report.tests, patterns) : undefined;
    if (unloaded) return { ok: false, reason: unloaded };
    let summary = report.kind === 'tests' ? `${report.tests.length} tests` : report.kind;
    if (report.kind === 'tests' && tool.runOne) {
      const target = report.tests.find(test => test.status !== 'skip');
      if (!target) return { ok: false, reason: 'runOne: the full run has no test that ran, so none to run alone' };
      if (/\{(file|within)\b/.test(tool.runOne) && !target.file)
        return {
          ok: false,
          reason: `runOne needs the file of ${target.id}, but the report has no file attribute (pytest: add -o junit_family=xunit1)`,
        };
      const one = run(tool, fillRunOne(tool.runOne, target), root);
      const oneProblem = notRunnable(one.exec);
      if (oneProblem) return { ok: false, reason: `runOne ${oneProblem}: ${target.id}` };
      if (!one.report || one.report.kind !== 'tests')
        return { ok: false, reason: `runOne report unreadable for ${target.id}` };
      const ran = one.report.tests.filter(test => test.status !== 'skip');
      if (ran.length !== 1)
        return {
          ok: false,
          reason: `runOne for ${target.id} ran ${ran.length} tests${ran.length ? `: ${ran.map(test => test.id).join(', ')}` : ''}`,
        };
      if (ran[0]!.id !== target.id) return { ok: false, reason: `runOne for ${target.id} ran ${ran[0]!.id} instead` };
      summary += ', runOne ok';
    }
    if (layer === 'L1' || layer === 'L2') {
      const again = run(tool, tool.command, root);
      const againProblem = notRunnable(again.exec);
      if (againProblem) return { ok: false, reason: `second run ${againProblem}: ${tool.command}` };
      if (report.kind === 'tests' && again.report?.kind !== 'tests')
        return {
          ok: false,
          reason: `second run report unusable: ${again.report?.kind === 'unreadable' ? again.report.reason : 'no test report'}`,
        };
      const same =
        again.report?.kind === 'tests' && report.kind === 'tests'
          ? signature(again.report.tests) === signature(report.tests)
          : again.exec.exitCode === first.exec.exitCode;
      if (!same) return { ok: false, reason: 'two runs gave different results (flaky)' };
      summary += ', stable over 2 runs';
    }
    return { ok: true, reason: summary };
  };

  type Scope = { part: string; root: string; layers: Partial<Record<string, LayerSpec[]>>; patterns: string[] };
  const scopes: Scope[] = [
    ...Object.entries(parsed.setup.parts).map(([part, setup]) => ({
      part,
      root: setup.root,
      layers: setup.layers,
      patterns: deps.catalog?.find(entry => entry.stack === setup.stack)?.loadErrorPatterns ?? [],
    })),
    { part: 'system', root: '.', layers: parsed.setup.system ?? {}, patterns: [] },
  ];
  for (const { part, root, layers, patterns } of scopes)
    for (const layer of LAYER_IDS)
      for (const tool of layers[layer] ?? []) {
        const outcome = probeTool(tool, layer, root, patterns);
        results.push({ part, layer, tool: tool.id, ...outcome });
      }
  for (const [part, setup] of Object.entries(parsed.setup.parts)) {
    if (!setup.tests) continue;
    const patterns = [
      ...setup.tests.assertPatterns,
      ...setup.tests.notImplementedPatterns,
      ...setup.tests.loadErrorPatterns,
    ];
    const bad = patterns.filter(pattern => {
      try {
        new RegExp(pattern, 'm');
        return false;
      } catch {
        return true;
      }
    });
    results.push({
      part,
      layer: 'tests',
      tool: 'patterns',
      ok: bad.length === 0,
      reason: bad.length
        ? `not a valid regular expression: ${bad.join(', ')}`
        : `${patterns.length} patterns compile; tests under ${setup.tests.paths.join(', ')}`,
    });
  }
  return { sha256: parsed.sha256, ok: results.length > 0 && results.every(item => item.ok), results };
}

/** Records the probe in the project log. */
export function recordProbe(
  journal: ProjectJournal,
  commit: string,
  report: ProbeReport,
  now: () => string = () => new Date().toISOString(),
): void {
  const event: ProjectEvent = {
    id: randomUUID(),
    type: 'setup-probed',
    at: now(),
    data: { sha256: report.sha256, commit, ok: report.ok, results: report.results },
  };
  journal.appendProjectEvent(event);
}
