import type { Finding, TestOutcome } from './results/types.js';
import { describeThreshold, holds, type Threshold } from './threshold.js';

export type Verdict = {
  status: 'pass' | 'fail' | 'unverifiable';
  reason: string;
};
export type FindingCount = { blocking: number; lower: number };

const FAILING = new Set<TestOutcome['status']>(['fail', 'error']);
const sorted = <T>(items: Iterable<T>): T[] => [...items].sort();

/** The runs of one layer agree when every run reports the same tests with the same statuses. Returns the ids that differ. */
function disagreement(runs: TestOutcome[][]): string[] {
  const ids = new Set(runs.flatMap(run => run.map(test => test.id)));
  const differing: string[] = [];
  for (const id of ids) {
    const seen = runs.map(run => run.find(test => test.id === id)?.status ?? 'absent');
    if (new Set(seen).size > 1) differing.push(id);
  }
  return sorted(differing);
}

/**
 * A test layer is green when its tests show no failure the base did not already have, and every locked test passes.
 * The locked tests were red at the base by design, so "already failing" never excuses them. Repeated runs that
 * disagree prove nothing (unverifiable), whichever run looks best.
 */
export function judgeTests(input: {
  label: string;
  head: TestOutcome[][];
  base: TestOutcome[] | undefined;
  /** Ids of the tests the lock pins in this layer. */
  locked: string[];
}): Verdict & { newFailures: string[] } {
  const { label, head } = input;
  const unverifiable = (reason: string) => ({ status: 'unverifiable' as const, reason, newFailures: [] });
  if (!head.length || head.every(run => !run.length))
    return unverifiable(`${label}: no test ran, so the layer proves nothing`);
  const differing = disagreement(head);
  if (differing.length)
    return unverifiable(
      `${label}: runs disagree (${head.length} runs), so nothing is proved: ${differing.slice(0, 5).join(', ')}${differing.length > 5 ? ', ...' : ''}`,
    );
  const [first] = head;
  const tests = first!;
  const atBase = new Map((input.base ?? []).map(test => [test.id, test.status]));
  const problems: string[] = [];
  const byId = new Map(tests.map(test => [test.id, test.status]));
  for (const id of sorted(input.locked)) {
    const status = byId.get(id);
    if (status !== 'pass') problems.push(`locked test ${id} is ${status ?? 'not in the report'}, not pass`);
  }
  const newFailures = tests
    .filter(test => FAILING.has(test.status) && !FAILING.has(atBase.get(test.id) ?? 'pass'))
    .map(test => test.id);
  if (newFailures.length)
    problems.push(`${newFailures.length} new failure(s) vs the base: ${newFailures.slice(0, 5).join(', ')}`);
  if (problems.length) return { status: 'fail', reason: `${label}: ${problems.join('; ')}`, newFailures };
  const known = tests.filter(test => FAILING.has(test.status)).length;
  return {
    status: 'pass',
    reason: `${label}: ${tests.length} tests, ${known} failing as at the base`,
    newFailures: [],
  };
}

const RANK: Record<Finding['level'], number> = { note: 0, warning: 1, error: 2 };

/** SARIF: red from the blocking level up. Findings below it are counted, so the table can show them, but never turn the layer red. */
export function judgeFindings(findings: Finding[], failOn: Finding['level']): Verdict & { findings: FindingCount } {
  const blocking = findings.filter(item => RANK[item.level] >= RANK[failOn]);
  const lower = findings.length - blocking.length;
  const count = { blocking: blocking.length, lower };
  if (blocking.length)
    return {
      status: 'fail',
      reason: `${blocking.length} finding(s) at ${failOn} or above${lower ? `, ${lower} below` : ''}: ${blocking
        .slice(0, 3)
        .map(item => `${item.ruleId}${item.file ? ` ${item.file}${item.line ? `:${item.line}` : ''}` : ''}`)
        .join(', ')}`,
      findings: count,
    };
  return {
    status: 'pass',
    reason: lower ? `${lower} finding(s) below ${failOn}, none blocking` : 'no findings',
    findings: count,
  };
}

const median = (values: number[]): number => {
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid]! : (ordered[mid - 1]! + ordered[mid]!) / 2;
};

/**
 * A metric measured `runs` times is judged against every threshold on each run. All runs inside: pass. All outside:
 * fail. Runs on both sides is `unverifiable`, never the best of them.
 */
export function judgeMetric(input: {
  name: string;
  values: number[];
  thresholds: Threshold[];
}): Verdict & { metric?: { name: string; value: number } } {
  const { name, values, thresholds } = input;
  if (!values.length) return { status: 'unverifiable', reason: `${name}: no measurement` };
  if (!thresholds.length) return { status: 'unverifiable', reason: `${name}: no threshold to judge it against` };
  const wanted = thresholds.map(item => describeThreshold(name, item)).join(' and ');
  const inside = values.map(value => thresholds.every(item => holds(value, item)));
  const metric = { name, value: median(values) };
  const list = values.join(', ');
  if (inside.every(Boolean)) return { status: 'pass', reason: `${wanted}: measured ${list}`, metric };
  if (!inside.some(Boolean)) return { status: 'fail', reason: `${wanted} does not hold: measured ${list}`, metric };
  return {
    status: 'unverifiable',
    reason: `${wanted}: runs disagree around the threshold (${list}), so nothing is proved`,
    metric,
  };
}
