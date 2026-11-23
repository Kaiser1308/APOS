import { floorReductions } from '../domain/exceptions.js';
import type { CheckResult, LayerPlanRecord } from '../domain/gate.js';
import { judgeFindings, judgeMetric, judgeTests, type Verdict } from '../domain/layer-verdict.js';
import { planLayers, skippedLayers, type LayerRun, type PlanInput, type Stage } from '../domain/layer-plan.js';
import { proofDemands, stricter, type FailOn, type ProofDemand } from '../domain/proof-tools.js';
import type { LayerSpec, ProjectSetup } from '../domain/project-setup.js';
import type { Threshold } from '../domain/threshold.js';
import type { TestOutcome } from '../domain/results/index.js';
import type { GoalState } from '../domain/transitions.js';
import { notRunnable, type ToolRunner } from './layer-runner.js';

export type LayerGateDeps = {
  runner: ToolRunner;
  /** The setup the Goal is pinned to, or undefined when it has none (then no layer runs). */
  loadSetup: (state: GoalState) => ProjectSetup | undefined;
};

export type LayerGateInput = {
  stage: Stage;
  /** A package id at `submit`; the Goal id at `integrate` and `close`. Picks the exceptions that reduce the floor. */
  scope: string;
  head: string;
  /** The commit the tests were locked on (or the plan's base): what "new failure" is measured against. */
  base: string | undefined;
  changed: string[];
};

const result = (checkId: string, verdict: Verdict, extra: Partial<CheckResult> = {}): CheckResult => ({
  checkId,
  status: verdict.status,
  reason: verdict.reason,
  base: [],
  delivery: [],
  newFailures: [],
  ...extra,
});
const unverifiable = (checkId: string, reason: string): CheckResult =>
  result(checkId, { status: 'unverifiable', reason });

/**
 * Runs the layers a stage plans, each in a clean worktree, and reads each result by its tool's format: `junit` and
 * `apos-json` for no new failure against the base (and every locked test passing), `exit` for the exit code, `sarif`
 * for findings from the blocking level up, `metric` against thresholds. A layer in which no test ran is
 * `unverifiable`, never green.
 */
export class LayerGate {
  constructor(private readonly deps: LayerGateDeps) {}

  /** The layers the Lead added, for one package, or for all of them at the stages that look at the Goal as a whole. */
  private packageLayers(state: GoalState, stage: Stage, scope: string): PlanInput['packageLayers'] {
    const packages = state.packages ?? {};
    const mine = packages[scope];
    if (mine) return mine.spec.layers;
    const merged = [...new Set(Object.values(packages).flatMap(item => item.spec.layers?.[stage] ?? []))];
    return merged.length ? { [stage]: merged } : undefined;
  }

  run(state: GoalState, input: LayerGateInput): { checks: CheckResult[]; layers?: LayerPlanRecord } {
    const setup = this.deps.loadSetup(state);
    if (!setup) return { checks: [] };
    const demands = new Map(proofDemands(state.spec).map(item => [item.tool, item]));
    const plan: PlanInput = {
      setup,
      stage: input.stage,
      changed: input.changed,
      packageLayers: this.packageLayers(state, input.stage, input.scope),
      goalFlags: state.spec.flags ?? [],
      reductions: floorReductions(state, input.scope, input.stage),
      requiredTools: [...demands.keys()],
    };
    const runs = planLayers(plan);
    const checks = runs
      .filter(run => !run.reduced)
      .flatMap(run => this.evaluate(state, setup, run, input, demands.get(`${run.part}.${run.layer}.${run.tool.id}`)));
    return {
      checks,
      layers: {
        stage: input.stage,
        runs: runs.map(run => ({
          part: run.part,
          layer: run.layer,
          tool: run.tool.id,
          format: run.tool.format,
          why: run.why,
          ...(run.reduced ? { reduced: true } : {}),
        })),
        skipped: skippedLayers(plan, runs),
      },
    };
  }

  private evaluate(
    state: GoalState,
    setup: ProjectSetup,
    run: LayerRun,
    input: LayerGateInput,
    demand: ProofDemand | undefined,
  ): CheckResult[] {
    const { tool } = run;
    const checkId = `${run.part}.${run.layer}.${tool.id}`;
    const root = run.part === 'system' ? '.' : (setup.parts[run.part]?.root ?? '.');
    const label = `${run.part}.${run.layer} ${tool.id}`;
    switch (tool.format) {
      case 'exit':
        return [this.exit(checkId, label, tool, root, input.head)];
      case 'sarif':
        return [this.sarif(checkId, label, tool, root, input.head, demand)];
      case 'metric':
        return this.metric(checkId, label, tool, root, input.head, demand);
      default:
        return [this.tests(state, setup, run, checkId, label, root, input)];
    }
  }

  private exit(checkId: string, label: string, tool: LayerSpec, root: string, head: string): CheckResult {
    const { exec } = this.deps.runner.run(head, tool, tool.command, root);
    const problem = notRunnable(exec);
    if (problem) return unverifiable(checkId, `${label}: ${problem}: ${tool.command}`);
    return exec.exitCode === 0
      ? result(checkId, { status: 'pass', reason: `${label}: exit 0` })
      : result(checkId, { status: 'fail', reason: `${label}: exit ${exec.exitCode}` });
  }

  private sarif(
    checkId: string,
    label: string,
    tool: LayerSpec,
    root: string,
    head: string,
    demand: ProofDemand | undefined,
  ): CheckResult {
    const { exec, report } = this.deps.runner.run(head, tool, tool.command, root);
    const problem = notRunnable(exec);
    if (problem) return unverifiable(checkId, `${label}: ${problem}: ${tool.command}`);
    const exitProblem = reportExitProblem(exec.exitCode, tool.reportExitCodes);
    if (exitProblem) return result(checkId, { status: 'fail', reason: `${label}: ${exitProblem}` });
    if (report?.kind !== 'findings')
      return unverifiable(
        checkId,
        `${label}: report unreadable: ${report?.kind === 'unreadable' ? report.reason : 'no findings report'}`,
      );
    let failOn: FailOn = tool.failOn ?? 'error';
    if (demand?.failOn) failOn = stricter(failOn, demand.failOn);
    const verdict = judgeFindings(report.findings, failOn);
    return result(checkId, { ...verdict, reason: `${label}: ${verdict.reason}` }, { findings: verdict.findings });
  }

  private metric(
    checkId: string,
    label: string,
    tool: LayerSpec,
    root: string,
    head: string,
    demand: ProofDemand | undefined,
  ): CheckResult[] {
    // The setup's threshold belongs to the metric the tool is configured with: the Goal's numbers for that same metric
    // come on top of it (every one must hold), and a criterion on another metric is judged by its own numbers only.
    const own: Threshold[] = tool.threshold ? [tool.threshold] : [];
    const asked: { name: string; thresholds: Threshold[] }[] = (demand?.metrics ?? []).map(item => ({
      name: item.name,
      thresholds: item.thresholds,
    }));
    if (!asked.length || (own.length && tool.metric && !asked.some(item => item.name === tool.metric)))
      asked.unshift({ name: tool.metric ?? '', thresholds: [] });
    return asked.map((wanted, index) => {
      const id = index === 0 ? checkId : `${checkId}:${wanted.name}`;
      const measured = { ...tool, ...(wanted.name ? { metric: wanted.name } : {}) };
      const values: number[] = [];
      for (let n = 0; n < (tool.runs ?? 3); n++) {
        const { exec, report } = this.deps.runner.run(head, measured, tool.command, root);
        const problem = notRunnable(exec);
        if (problem) return unverifiable(id, `${label}: ${problem}: ${tool.command}`);
        const exitProblem = reportExitProblem(exec.exitCode, tool.reportExitCodes);
        if (exitProblem) return result(id, { status: 'fail', reason: `${label}: ${exitProblem}` });
        if (report?.kind !== 'metric')
          return unverifiable(
            id,
            `${label}: report unreadable: ${report?.kind === 'unreadable' ? report.reason : 'no metric report'}`,
          );
        values.push(report.value);
      }
      const verdict = judgeMetric({
        name: wanted.name || tool.metric || 'value',
        values,
        thresholds: [...(!tool.metric || wanted.name === tool.metric ? own : []), ...wanted.thresholds],
      });
      return result(
        id,
        { ...verdict, reason: `${label}: ${verdict.reason}` },
        verdict.metric ? { metric: verdict.metric } : {},
      );
    });
  }

  private tests(
    state: GoalState,
    setup: ProjectSetup,
    run: LayerRun,
    checkId: string,
    label: string,
    root: string,
    input: LayerGateInput,
  ): CheckResult {
    const { runner } = this.deps;
    const { tool } = run;
    const head: TestOutcome[][] = [];
    for (let n = 0; n < (tool.runs ?? 1); n++) {
      const got = runner.layerTests(input.head, run.part, root, run.layer, [tool]);
      if (got.problems.length) return unverifiable(checkId, `the layer did not run: ${got.problems.join('; ')}`);
      if (got.processFailures.length)
        return result(checkId, { status: 'fail', reason: got.processFailures.join('; ') });
      head.push(got.tests);
    }
    const atBase = input.base ? runner.layerTests(input.base, run.part, root, run.layer, [tool]) : undefined;
    // With two tools in one layer a locked test belongs to the tool that reported it when the tests were locked (the base),
    // not to whichever report it shows up in now: a locked test that vanishes from its own tool's report is red.
    const shared = (setup.parts[run.part]?.layers[run.layer]?.length ?? 0) > 1;
    const owned = atBase && !atBase.problems.length ? new Set(atBase.tests.map(test => test.id)) : undefined;
    // A package answers for the locked tests of its own criteria; at the later stages the Goal answers for all of them.
    const mine = state.packages?.[input.scope];
    const answersFor = (acceptanceId: string) =>
      !mine || mine.spec.acceptance.some(criterion => criterion.goalAcceptanceId === acceptanceId);
    const locked = (state.testLock?.map ?? [])
      .filter(entry => entry.part === run.part && entry.layer === run.layer && answersFor(entry.acceptanceId))
      .flatMap(entry => entry.testIds)
      .filter(id => !shared || !owned || owned.has(id));
    const verdict = judgeTests({
      label,
      head,
      base: atBase && !atBase.problems.length ? atBase.tests : undefined,
      locked,
      loadErrorPatterns: setup.parts[run.part]?.tests?.loadErrorPatterns,
    });
    return result(checkId, verdict, { newFailures: verdict.newFailures });
  }
}

function reportExitProblem(exitCode: number | null, accepted: number[] | undefined): string | undefined {
  const allowed = accepted ?? [0];
  if (exitCode !== null && allowed.includes(exitCode)) return undefined;
  return `command exited ${exitCode ?? 'without an exit code'}; accepted report exit codes: ${allowed.join(', ')}`;
}
