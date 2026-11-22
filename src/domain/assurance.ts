import type { CheckResult } from './gate.js';
import { matchesAny } from './glob.js';
import { testKey, type LayerOutcome, type TestLock } from './test-lock.js';

export const LOCKED_CHECK = 'APOS-LOCKED';
export const INVENTORY_CHECK = 'APOS-INVENTORY';
export const SCOPE_CHECK = 'APOS-SCOPE';
export const INFRA_CHECK = 'APOS-INFRA';

const result = (checkId: string, status: CheckResult['status'], reason: string): CheckResult => ({
  checkId,
  status,
  reason,
  base: [],
  delivery: [],
  newFailures: [],
});

export type TestStatus = 'pass' | 'fail' | 'error' | 'skip';
/** Tests keyed `<part>.<layer>::<id>`, as the layer runs of one commit give them. */
export type TestSet = Record<string, TestStatus>;

export function testSetOf(
  outcomes: LayerOutcome[],
  layerOf: (outcome: LayerOutcome) => string = o => o.layer,
): TestSet {
  const set: TestSet = {};
  for (const outcome of outcomes)
    for (const test of outcome.tests) set[testKey(outcome.part, layerOf(outcome), test.id)] = test.status;
  return set;
}

/**
 * The locked tests are the contract: a locked file that is not byte-for-byte what was locked is red, and every test the
 * package's criteria point at must pass on the delivery. `deliveryFiles` maps each locked path to its sha256 on the
 * delivery, or undefined when the file is gone. `delivery` is the full layer run, not a run of single tests.
 */
export function lockedTestsCheck(input: {
  lock: TestLock;
  deliveryFiles: Record<string, string | undefined>;
  delivery: TestSet;
  /** The Goal criteria this package answers for. */
  criteria: string[];
  /** Why the layers could not run on the delivery. A changed locked file is red all the same, whatever else broke. */
  runProblems?: string[];
}): CheckResult {
  const problems: string[] = [];
  for (const [path, hash] of Object.entries(input.lock.files)) {
    const now = input.deliveryFiles[path];
    if (now !== hash) problems.push(`locked test modified: ${path}${now === undefined ? ' (deleted)' : ''}`);
  }
  if (input.runProblems?.length)
    return problems.length
      ? result(LOCKED_CHECK, 'fail', problems.join('; '))
      : result(LOCKED_CHECK, 'unverifiable', `the delivery layers did not run: ${input.runProblems.join('; ')}`);
  for (const entry of input.lock.map) {
    if (!input.criteria.includes(entry.acceptanceId)) continue;
    for (const id of entry.testIds) {
      const status = input.delivery[testKey(entry.part, entry.layer, id)];
      if (status !== 'pass')
        problems.push(
          `${entry.acceptanceId} ${entry.part}.${entry.layer} ${id}: ${status === undefined ? 'not in the delivery report' : `is ${status}, not pass`}`,
        );
    }
  }
  return problems.length
    ? result(LOCKED_CHECK, 'fail', problems.join('; '))
    : result(
        LOCKED_CHECK,
        'pass',
        `${Object.keys(input.lock.files).length} locked files unchanged; the package's locked tests pass`,
      );
}

/**
 * No test is lost: every test that ran (pass, fail or error) at the base is still in the delivery and not skipped, and
 * no `forbid` pattern shows up in a line the delivery added. A skipped test at the base may stay skipped.
 */
export function inventoryCheck(input: {
  base: TestSet;
  delivery: TestSet;
  addedLines: string[];
  forbid: string[];
}): CheckResult {
  const problems: string[] = [];
  for (const [key, status] of Object.entries(input.base)) {
    if (status === 'skip') continue;
    const now = input.delivery[key];
    if (now === undefined) problems.push(`test missing: ${key}`);
    else if (now === 'skip') problems.push(`test now skipped: ${key}`);
  }
  for (const pattern of input.forbid) {
    const re = new RegExp(pattern);
    const hit = input.addedLines.find(line => re.test(line));
    if (hit !== undefined)
      problems.push(`forbidden pattern /${pattern}/ in an added line: ${hit.trim().slice(0, 120)}`);
  }
  return problems.length
    ? result(INVENTORY_CHECK, 'fail', problems.join('; '))
    : result(INVENTORY_CHECK, 'pass', `${Object.keys(input.base).length} tests at the base are all still there`);
}

/**
 * Files outside the package's `paths` are red. A file that matches `needsHuman` is not judged by `paths` at all: it
 * waits for a decision (`needs-human`), so approving it does not also leave an out-of-scope red. Files under `.apos/`
 * belong to APOS-PROTECTED, and locked test files to APOS-LOCKED, so neither is counted twice.
 */
export function scopeCheck(input: {
  changed: string[];
  paths: string[];
  needsHuman: string[];
  lockedFiles: string[];
}): CheckResult {
  const outside: string[] = [];
  const sensitive: string[] = [];
  for (const file of input.changed) {
    if (file.startsWith('.apos/') || input.lockedFiles.includes(file)) continue;
    if (matchesAny(file, input.needsHuman)) sensitive.push(file);
    else if (!matchesAny(file, input.paths)) outside.push(file);
  }
  if (outside.length)
    return result(
      SCOPE_CHECK,
      'fail',
      `outside the package paths (${input.paths.join(', ')}): ${outside.join(', ')}${sensitive.length ? `; sensitive files also changed: ${sensitive.join(', ')}` : ''}`,
    );
  if (sensitive.length)
    return result(SCOPE_CHECK, 'needs-human', `sensitive files changed, a decision is needed: ${sensitive.join(', ')}`);
  return result(SCOPE_CHECK, 'pass', 'every changed file is inside the package paths');
}

/**
 * Test infrastructure (conftest, runner config, setup files) can turn a locked red test green without touching it, so a
 * file that matches the setup's `testInfra` and differs from the lock (changed, added or deleted) needs a decision.
 * `delivery` maps every infra file on the delivery to its sha256. `inherited` are files a green dependency already
 * brought, unchanged since its own gate.
 */
export function infraCheck(input: {
  lockInfra: Record<string, string>;
  delivery: Record<string, string>;
  inherited?: ReadonlySet<string>;
}): CheckResult {
  const touched = [...new Set([...Object.keys(input.lockInfra), ...Object.keys(input.delivery)])]
    .filter(path => input.lockInfra[path] !== input.delivery[path] && !input.inherited?.has(path))
    .sort();
  return touched.length
    ? result(INFRA_CHECK, 'needs-human', `hạ tầng test bị sửa: ${touched.join(', ')}`)
    : result(INFRA_CHECK, 'pass', 'test infrastructure unchanged since the lock');
}
