import type { CheckResult } from './gate.js';
import { matchesAny } from './glob.js';
import { entryMatches, type RemovedTest } from './removal.js';
import { testRefKey, type ReviewTestLock } from './review-tests.js';
import { testKey, type LayerOutcome, type TestLock } from './test-lock.js';

export const LOCKED_CHECK = 'APOS-LOCKED';
export const INVENTORY_CHECK = 'APOS-INVENTORY';
export const SCOPE_CHECK = 'APOS-SCOPE';
export const INFRA_CHECK = 'APOS-INFRA';
export const REVIEW_CHECK = 'APOS-REVIEW';

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
 *
 * A Goal with `removed` criteria declares the old tests that go (`removable`): exactly those may be gone. A declared test
 * the delivery still has (whatever its status), or one the base never had, is red; so is any other test that is gone.
 * `lockedBy` says which other Goal locked a test, so the table can say whose tests went.
 */
export function inventoryCheck(input: {
  base: TestSet;
  delivery: TestSet;
  addedLines: string[];
  forbid: string[];
  removable?: RemovedTest[];
  lockedBy?: (key: string) => string | undefined;
}): CheckResult {
  const problems: string[] = [];
  const declared = input.removable ?? [];
  const isDeclared = (key: string) => declared.some(item => entryMatches(item.entry, key));
  const removed: string[] = [];
  for (const [key, status] of Object.entries(input.base)) {
    const now = input.delivery[key];
    if (isDeclared(key)) {
      if (now !== undefined) problems.push(`declared removed but still there: ${key}`);
      else removed.push(key);
      continue;
    }
    if (status === 'skip') continue;
    if (now === undefined) problems.push(`test missing: ${key}`);
    else if (now === 'skip') problems.push(`test now skipped: ${key}`);
  }
  // A declared file or test that reports a test the base did not have (a renamed one, another parameterization) is still there.
  for (const key of Object.keys(input.delivery))
    if (!(key in input.base) && isDeclared(key)) problems.push(`declared removed but still there: ${key}`);
  for (const item of declared)
    if (!Object.keys(input.base).some(key => entryMatches(item.entry, key)))
      problems.push(`declared removed but not on the base: ${item.entry}`);
  for (const pattern of input.forbid) {
    const re = new RegExp(pattern);
    const hit = input.addedLines.find(line => re.test(line));
    if (hit !== undefined)
      problems.push(`forbidden pattern /${pattern}/ in an added line: ${hit.trim().slice(0, 120)}`);
  }
  if (problems.length) return result(INVENTORY_CHECK, 'fail', problems.join('; '));
  const kept = Object.keys(input.base).length - removed.length;
  if (!declared.length) return result(INVENTORY_CHECK, 'pass', `${kept} tests at the base are all still there`);
  const owners = new Map<string, string[]>();
  for (const key of removed) {
    const owner = input.lockedBy?.(key);
    if (owner) owners.set(owner, [...(owners.get(owner) ?? []), key]);
  }
  const locked = [...owners].sort(([a], [b]) => a.localeCompare(b)).map(([goalId, tests]) => ({ goalId, tests }));
  return {
    ...result(
      INVENTORY_CHECK,
      'pass',
      `${kept} tests at the base are all still there; the ${removed.length} declared as removed are gone`,
    ),
    removal: { tests: removed, locked },
  };
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

/**
 * The tests reviewers added to this package are locked like the tester's: the delivery holds each file unchanged and
 * every test passes. A block the Lead overrode (`overridden` says by whom) asks for nothing, and the table says so.
 */
export function reviewTestsCheck(input: {
  reviews: ReviewTestLock[];
  overriddenBy: (review: ReviewTestLock) => string | undefined;
  deliveryFiles: (review: ReviewTestLock) => Record<string, string | undefined>;
  delivery: TestSet;
}): CheckResult {
  const problems: string[] = [];
  const waived: string[] = [];
  let kept = 0;
  for (const review of input.reviews) {
    const by = input.overriddenBy(review);
    if (by) {
      waived.push(`review bị bỏ qua: ${review.blocking.map(test => test.id).join(', ')}, duyệt bởi ${by}`);
      continue;
    }
    for (const [path, hash] of Object.entries(review.files)) {
      const now = input.deliveryFiles(review)[path];
      if (now !== hash)
        problems.push(
          `review test modified: ${path}${now === undefined ? ' (missing: build on the review commit)' : ''}`,
        );
    }
    for (const test of review.tests) {
      const status = input.delivery[testRefKey(test)];
      kept += 1;
      if (status !== 'pass')
        problems.push(
          `review test ${test.id}: ${status === undefined ? 'not in the delivery report' : `is ${status}, not pass`}`,
        );
    }
  }
  if (problems.length) return result(REVIEW_CHECK, 'fail', problems.join('; '));
  return result(
    REVIEW_CHECK,
    'pass',
    [kept ? `${kept} review test(s) unchanged and passing` : '', ...waived].filter(Boolean).join('; '),
  );
}
