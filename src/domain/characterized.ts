import { lockedTestsCheck, type TestSet } from './assurance.js';
import type { CheckResult } from './gate.js';
import type { Characterization } from './legacy.js';
import { matchesAny } from './glob.js';
import { lockedTestKeys } from './test-lock.js';

export const CHARACTERIZED_CHECK = 'APOS-CHARACTERIZED';

/**
 * A refactor keeps what the characterize Goals captured: every test they locked for the code it touches is green on the
 * base (the behaviour was captured as it was), still there byte for byte on the delivery, and green on the delivery. It
 * reuses the check of locked tests, one run per characterize Goal, and adds the "green before" half, which the lock
 * check does not look at. `deliveryFiles` maps each locked path to its sha256 on the delivery (undefined: gone).
 */
export function characterizedCheck(input: {
  sources: Characterization[];
  /** Every closed characterize Goal, oldest lock first (default: `sources`): a test file a Goal outside `sources` added tests to is newer too. */
  held?: Characterization[];
  deliveryFiles: Record<string, string | undefined>;
  delivery: TestSet;
  base: TestSet;
  /** Why the layers could not run, on the base or the delivery. */
  runProblems?: string[];
}): CheckResult {
  const result = (status: CheckResult['status'], reason: string, extra: Partial<CheckResult> = {}): CheckResult => ({
    checkId: CHARACTERIZED_CHECK,
    status,
    reason,
    base: [],
    delivery: [],
    newFailures: [],
    ...extra,
  });
  if (!input.sources.length)
    return result(
      'fail',
      'no closed characterize Goal covers the code this Goal touches: nothing holds the refactor to the old behaviour',
    );
  const failures: string[] = [];
  const unverifiable: string[] = [];
  let tests = 0;
  // Two characterize Goals can lock the same file (the later one adds or strengthens tests in it): a delivery holds one
  // version, and it must be the newest a lock recorded, the strongest. `sources` run from the oldest lock to the newest.
  const newest = (path: string, own: string) =>
    [...(input.held ?? input.sources)].reverse().find(item => item.lock.files[path] !== undefined)?.lock.files[path] ??
    own;
  for (const { goalId, lock } of input.sources) {
    const files = Object.fromEntries(Object.entries(lock.files).map(([path, hash]) => [path, newest(path, hash)]));
    const delivered = lockedTestsCheck({
      lock: { ...lock, files },
      deliveryFiles: input.deliveryFiles,
      delivery: input.delivery,
      criteria: lock.map.map(entry => entry.acceptanceId),
      runProblems: input.runProblems,
    });
    if (delivered.status === 'fail') failures.push(`${goalId}: ${delivered.reason}`);
    else if (delivered.status !== 'pass') unverifiable.push(`${goalId}: ${delivered.reason}`);
    for (const key of lockedTestKeys(lock)) {
      tests += 1;
      if (input.runProblems?.length) continue;
      const status = input.base[key];
      if (status !== 'pass')
        failures.push(
          `${goalId} ${key}: ${status === undefined ? 'not in the base report: the base does not hold the captured tests' : `is ${status} on the base, not pass`}`,
        );
    }
  }
  if (failures.length) return result('fail', failures.join('; '));
  if (unverifiable.length) return result('unverifiable', unverifiable.join('; '));
  const from = input.sources.map(item => item.goalId);
  return result(
    'pass',
    `${tests} captured test(s) from ${from.join(', ')}: green on the base, unchanged and green on the delivery`,
    {
      preserved: { tests, from },
    },
  );
}

export const REFACTOR_SCOPE_CHECK = 'APOS-REFACTOR-SCOPE';

/**
 * A refactor touches only what the Human approved with it: every file the delivery changed matches the Goal's `paths`,
 * whatever scope the plan or a package declared (a plan the Lead can still change must not widen it). Locked tests are left
 * to their own check. A sensitive file (`needsHuman`) is decided by the package gate (`needs-human`, with an approval): one
 * that no package gate judged (`judged` lists the files they saw) was introduced by the integration commit itself, and is red.
 */
export function refactorScopeCheck(input: {
  changed: string[];
  paths: string[];
  needsHuman: string[];
  lockedFiles: string[];
  /** The files some package gate already judged, sensitive ones included. */
  judged: string[];
}): CheckResult {
  const outside: string[] = [];
  const unjudged: string[] = [];
  for (const file of input.changed) {
    if (file.startsWith('.apos/') || input.lockedFiles.includes(file)) continue;
    if (matchesAny(file, input.needsHuman)) {
      if (!input.judged.includes(file)) unjudged.push(file);
    } else if (!matchesAny(file, input.paths)) outside.push(file);
  }
  const problems = [
    ...(outside.length
      ? [`outside the paths the Human approved for this refactor (${input.paths.join(', ')}): ${outside.join(', ')}`]
      : []),
    ...(unjudged.length
      ? [`sensitive file(s) changed by the integration itself, which no package gate judged: ${unjudged.join(', ')}`]
      : []),
  ];
  return {
    checkId: REFACTOR_SCOPE_CHECK,
    status: problems.length ? 'fail' : 'pass',
    reason: problems.length
      ? problems.join('; ')
      : 'every changed file is inside the refactor paths the Human approved',
    base: [],
    delivery: [],
    newFailures: [],
  };
}
