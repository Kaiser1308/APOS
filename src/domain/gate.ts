import { createHash } from 'node:crypto';
import type { CommandCheck, GoalCheck, GoalSpec } from './contracts.js';
import type { GoalState } from './transitions.js';

/** One execution of one check on one commit, in a fresh workspace. */
export type CheckRun = {
  commit: string;
  exitCode: number | null;
  timedOut: boolean;
  logRef: string;
  logSha256: string;
  failures: string[];
};
export type CheckStatus = 'pass' | 'fail' | 'unverifiable' | 'manual-pending';
export type CheckResult = {
  checkId: string;
  status: CheckStatus;
  reason: string;
  base: CheckRun[];
  delivery: CheckRun[];
  newFailures: string[];
};
export type GateResult = 'green' | 'red' | 'unverifiable' | 'pending';
export type GateEnvironment = { platform: string; shell: string; node: string };
export type GateReport = {
  gateId: string;
  goalId: string;
  goalVersion: number;
  sourceSha256: string;
  baseCommit: string;
  deliveryCommit: string;
  /** Owner attempt the gate was started for; a gate that finishes after a resume is rejected. */
  attemptKey: string;
  /** Files changed from base to delivery; drives the review requirement. */
  changedFiles?: string[];
  /** `post-merge` reruns the checks on the merge commit at the target branch. */
  phase?: 'delivery' | 'post-merge';
  environment: GateEnvironment;
  checks: CheckResult[];
  result: GateResult;
  at: string;
};
export type ManualConfirmation = { checkId: string; deliveryCommit: string; by: string; note: string };

/** Source snapshots are hashed with line endings normalised so Git's autocrlf cannot fake a change. */
export function sourceDigest(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Identifies the owner attempt(s) whose delivery a gate judges: Solo dispatch + attempt, or every package's. */
export function attemptKey(state: GoalState): string {
  const solo = state.runtimeRef as { dispatchId?: string } | undefined;
  const packages = Object.values(state.packages ?? {})
    .map(
      item =>
        `${item.spec.id}@${item.spec.version}:${item.attempts}:${(item.runtimeRef as { dispatchId?: string } | undefined)?.dispatchId ?? '-'}`,
    )
    .sort();
  return [`solo:${solo?.dispatchId ?? '-'}:${state.soloAttempts ?? 0}`, ...packages].join('|');
}

export function extractFailures(output: string, pattern: string | undefined): string[] {
  if (!pattern) return [];
  const found = new Set<string>();
  for (const match of output.matchAll(new RegExp(pattern, 'gm'))) {
    const value = (match[1] ?? match[0]).trim();
    if (value) found.add(value);
  }
  return [...found].sort();
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/** Repeated runs of the same commit must agree, otherwise the result is flaky and proves nothing. */
function consistent(runs: CheckRun[]): string | undefined {
  if (runs.some(run => run.timedOut)) return 'timed out';
  const [first, ...rest] = runs;
  if (rest.some(run => (run.exitCode === 0) !== (first.exitCode === 0) || !same(run.failures, first.failures)))
    return 'flaky: repeated runs disagree';
  return undefined;
}

export function evaluateCommandCheck(check: CommandCheck, base: CheckRun[], delivery: CheckRun[]): CheckResult {
  const result = (status: CheckStatus, reason: string, newFailures: string[] = []): CheckResult => ({
    checkId: check.id,
    status,
    reason,
    base,
    delivery,
    newFailures,
  });
  if (!delivery.length) return result('unverifiable', 'delivery was not run');
  const deliveryProblem = consistent(delivery);
  if (deliveryProblem) return result('unverifiable', `delivery ${deliveryProblem}`);
  const head = delivery[0];
  if (check.expect === 'pass')
    return head.exitCode === 0
      ? result('pass', 'exit 0 on delivery')
      : result('fail', `exit ${head.exitCode} on delivery`);

  if (!base.length) return result('unverifiable', 'baseline was not run');
  const baseProblem = consistent(base);
  if (baseProblem) return result('unverifiable', `baseline ${baseProblem}`);
  if (base[0].exitCode !== 0 && !base[0].failures.length)
    return result('unverifiable', `baseline exit ${base[0].exitCode} without identifiable failures`);
  if (head.exitCode !== 0 && !head.failures.length)
    return result('fail', `delivery exit ${head.exitCode} without identifiable failures`);
  const known = new Set(base[0].failures);
  const fresh = head.failures.filter(item => !known.has(item));
  if (fresh.length) return result('fail', `${fresh.length} new failure(s) vs base`, fresh);
  return result(
    'pass',
    head.failures.length ? `${head.failures.length} failure(s) already present on base` : 'no failures',
  );
}

export function evaluateManualCheck(
  check: Extract<GoalCheck, { kind: 'manual' }>,
  deliveryCommit: string,
  confirmations: ManualConfirmation[],
): CheckResult {
  const confirmed = confirmations.find(item => item.checkId === check.id && item.deliveryCommit === deliveryCommit);
  return {
    checkId: check.id,
    status: confirmed ? 'pass' : 'manual-pending',
    reason: confirmed
      ? `confirmed by ${confirmed.by}: ${confirmed.note}`
      : 'awaiting manual confirmation on this commit',
    base: [],
    delivery: [],
    newFailures: [],
  };
}

/**
 * Files under `.apos/` are the controller's contract and skills; a delivery may add only its own
 * evidence and review files. Anything else in the diff fails the gate, so an owner cannot rewrite the
 * skills, Goal documents or sources that briefs, reviewers and future dispatches trust.
 */
export function protectedChanges(goalId: string, changedFiles: string[]): string[] {
  return changedFiles.filter(
    file =>
      file.startsWith('.apos/') &&
      !file.startsWith(`.apos/goals/${goalId}/evidence/`) &&
      !file.startsWith(`.apos/goals/${goalId}/reviews/`),
  );
}
export const PROTECTED_CHECK = 'APOS-PROTECTED';
export function protectedCheck(goalId: string, changedFiles: string[]): CheckResult | undefined {
  const touched = protectedChanges(goalId, changedFiles);
  return touched.length
    ? {
        checkId: PROTECTED_CHECK,
        status: 'fail',
        reason: `delivery modifies APOS-managed files: ${touched.join(', ')}`,
        base: [],
        delivery: [],
        newFailures: [],
      }
    : undefined;
}

export function summarizeGate(checks: CheckResult[]): GateResult {
  if (checks.some(item => item.status === 'fail')) return 'red';
  if (checks.some(item => item.status === 'unverifiable')) return 'unverifiable';
  if (checks.some(item => item.status === 'manual-pending')) return 'pending';
  return 'green';
}

/** Checks that some acceptance criterion depends on; only these gate the Goal. */
export function requiredChecks(goal: GoalSpec): GoalCheck[] {
  const wanted = new Set(goal.acceptance.flatMap(item => item.checkIds));
  return goal.checks.filter(item => wanted.has(item.id));
}

/** Why a recorded gate does not prove this Goal at this commit; empty when it does. */
export function gateShortfalls(goal: GoalSpec, gate: GateReport | undefined, deliveryCommit?: string): string[] {
  if (!gate) return ['no controller gate has run'];
  const problems: string[] = [];
  if (gate.goalVersion !== goal.version)
    problems.push(`gate ran for Goal v${gate.goalVersion}, current is v${goal.version}`);
  if (goal.source.sha256 !== gate.sourceSha256) problems.push('gate ran against a different source snapshot');
  if (deliveryCommit && deliveryCommit.toLowerCase() !== gate.deliveryCommit.toLowerCase())
    problems.push(`gate ran on ${gate.deliveryCommit}, not ${deliveryCommit}`);
  if (gate.result !== 'green') problems.push(`gate is ${gate.result}`);
  const passed = new Set(gate.checks.filter(item => item.status === 'pass').map(item => item.checkId));
  for (const item of goal.acceptance) {
    const missing = item.checkIds.filter(checkId => !passed.has(checkId));
    if (missing.length) problems.push(`${item.id} lacks passing check(s): ${missing.join(', ')}`);
  }
  return problems;
}
