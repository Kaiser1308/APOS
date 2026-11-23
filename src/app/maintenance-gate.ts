import { execFileSync } from 'node:child_process';
import { diffFindings } from '../domain/findings.js';
import type { CheckResult } from '../domain/gate.js';
import type { LayerSpec } from '../domain/project-setup.js';
import type { Finding } from '../domain/results/index.js';
import type { GoalSpec } from '../domain/contracts.js';
import { notRunnable, reportExitProblem, type ToolRunner } from './layer-runner.js';

type Scanned = { findings: Finding[] } | { problem: string };

/** Two scans agree when they show the same findings at the same severity: a finding that blocks in one run and not in the other is a disagreement. */
const same = (a: Finding[], b: Finding[]): boolean => {
  const keys = (items: Finding[]) => new Set(items.map(item => `${item.fingerprint}\n${item.level}`));
  const left = keys(a);
  const right = keys(b);
  return left.size === right.size && [...left].every(key => right.has(key));
};

/** One scan on one commit, run twice: two runs that show different findings prove nothing. */
export function scanTwice(
  runner: Pick<ToolRunner, 'run'>,
  commit: string,
  tool: LayerSpec,
  root: string,
  label: string,
): Scanned {
  const runs: Finding[][] = [];
  for (let n = 0; n < 2; n++) {
    const { exec, report } = runner.run(commit, tool, tool.command, root);
    const problem = notRunnable(exec);
    if (problem) return { problem: `${label}: ${problem}: ${tool.command}` };
    const exitProblem = reportExitProblem(exec.exitCode, tool.reportExitCodes);
    if (exitProblem) return { problem: `${label}: ${exitProblem}` };
    if (report?.kind !== 'findings')
      return {
        problem: `${label}: report unreadable: ${report?.kind === 'unreadable' ? report.reason : 'no findings report'}`,
      };
    runs.push(report.findings);
  }
  if (!same(runs[0]!, runs[1]!))
    return { problem: `${label}: two scans of ${commit.slice(0, 7)} show different findings, so nothing is proved` };
  return { findings: runs[0]! };
}

/**
 * Whether two commits hold the same project: nothing differs outside `.apos/`, where APOS's own milestone commits (the
 * source snapshot, the plan) land between opening a Goal and planning it. A scan of one is a scan of the other.
 */
export function sameProject(repo: string, a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  try {
    execFileSync('git', ['-C', repo, 'diff', '--quiet', a, b, '--', '.', ':(exclude).apos'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A SARIF layer of a maintenance Goal: the delivery may not show a finding the base did not (by fingerprint), at the
 * blocking level or above. Findings below that level are counted. The base is what the Goal recorded when it was opened,
 * when that was this very commit; otherwise the base is scanned here, twice.
 */
export function maintenanceScan(input: {
  runner: Pick<ToolRunner, 'run'>;
  goal: GoalSpec;
  checkId: string;
  label: string;
  tool: LayerSpec;
  root: string;
  head: string;
  base: string;
  failOn: Finding['level'];
  /** Whether the commit the Goal recorded its base scan on holds the same project as `base`. */
  recordedIsBase: boolean;
}): CheckResult {
  const { runner, goal, checkId, label, tool, root, head, base, failOn } = input;
  const result = (status: CheckResult['status'], reason: string, extra: Partial<CheckResult> = {}): CheckResult => ({
    checkId,
    status,
    reason,
    base: [],
    delivery: [],
    newFailures: [],
    ...extra,
  });
  const delivery = scanTwice(runner, head, tool, root, label);
  if ('problem' in delivery) return result('unverifiable', delivery.problem);
  // The record stands for this scanner only: a setup that changed the command since the Goal was opened is scanned again.
  const recorded = input.recordedIsBase
    ? goal.baseline?.scans.find(scan => scan.tool === checkId && scan.command === tool.command)
    : undefined;
  let before: Finding[];
  if (recorded) before = recorded.findings.map(item => ({ ...item, level: item.level }));
  else {
    const scanned = scanTwice(runner, base, tool, root, `${label} on the base`);
    if ('problem' in scanned) return result('unverifiable', scanned.problem);
    before = scanned.findings;
  }
  const diff = diffFindings(before, delivery.findings, failOn);
  const scan = {
    baseCommit: base,
    baseTotal: diff.baseTotal,
    newBlocking: diff.newBlocking.length,
    newLower: diff.newLower,
    fixed: diff.fixed,
    remaining: [...new Set(before.map(item => item.fingerprint))].filter(print => !diff.fixed.includes(print)),
  };
  if (diff.newBlocking.length)
    return result(
      'fail',
      `${label}: ${diff.newBlocking.length} new finding(s) vs the base at ${failOn} or above: ${diff.newBlocking
        .slice(0, 3)
        .map(item => `${item.ruleId}${item.file ? ` ${item.file}` : ''} [${item.fingerprint}]`)
        .join(', ')}`,
      { scan },
    );
  return result(
    'pass',
    `${label}: no new finding vs the base (${diff.baseTotal} on the base, ${diff.fixed.length} gone${diff.newLower ? `, ${diff.newLower} new below ${failOn}` : ''})`,
    { scan },
  );
}
