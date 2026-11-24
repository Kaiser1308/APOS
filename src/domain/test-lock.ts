import { z } from 'zod';
import { InvariantError } from './errors.js';
import { entryMatches } from './removal-match.js';
import type { TestOutcome } from './results/index.js';
import type { GoalEvent, GoalState } from './transitions.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-fA-F]{40,64}$/);
const partName = z.string().regex(/^[a-z][a-z0-9-]*$/);
const acceptanceId = z.string().regex(/^[A-Z][A-Z0-9-]+$/);

/** The layers whose tests a tester writes before the code: acceptance, integration, end-to-end. */
export const LOCKED_LAYERS = ['L2', 'L3', 'L4'] as const;
export type LockedLayer = (typeof LOCKED_LAYERS)[number];

const mapEntry = z.object({
  acceptanceId,
  part: partName,
  layer: z.enum(LOCKED_LAYERS),
  testIds: z.array(z.string().min(1)).min(1),
});
export type TestMapEntry = z.infer<typeof mapEntry>;
/** `.apos/goals/<id>/tests.json`: which tests prove which criterion, by the ids the layer's report gives them. */
export const testMapSchema = z.array(mapEntry);
export const testMapPath = (goalId: string): string => `.apos/goals/${goalId}/tests.json`;

const lockSchema = z.object({
  commit,
  files: z.record(z.string().min(1), sha256),
  asserts: z.record(z.string().min(1), z.number().int().nonnegative()),
  /** sha256 of every test-infrastructure file (conftest, runner config ...) present at the lock commit. Absent on a lock from before this existed. */
  infra: z.record(z.string().min(1), sha256).optional(),
  map: testMapSchema,
  /** Parts whose acceptance tests were not held to the declared entries because their stack has no `entryRule`: the assurance table says "chưa kiểm". */
  unchecked: z.array(z.string()).optional(),
  by: z.string().min(1),
  /** The commit this lock replaced, for a revision. */
  revisionOf: commit.optional(),
  reason: z.string().min(1).optional(),
});
export type TestLock = z.infer<typeof lockSchema>;

export type TestRevisionPending = { commit: string; reason: string; problems: string[]; by: string };

/** The test ids a lock pins, as `<part>.<layer>::<id>`. */
export const lockedTestKeys = (lock: TestLock): string[] =>
  lock.map.flatMap(entry => entry.testIds.map(id => testKey(entry.part, entry.layer, id)));
export const testKey = (part: string, layer: string, id: string): string => `${part}.${layer}::${id}`;

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new InvariantError(message);
}

/**
 * `tests-locked` ends the `testing` stage (or, with `revisionOf`, replaces the lock while the Goal executes: every
 * package then has to be gated again on the new base). `tests-revision-pending` parks a revision that needs a
 * decision. `apos tests submit` and `revise` check the rules first as UserErrors; a violation here is a defect.
 */
export function applyTestLockEvent(state: GoalState, event: GoalEvent): GoalState {
  if (event.type === 'tests-revision-pending') {
    const data = event.data as TestRevisionPending | undefined;
    requireThat(
      state.status === 'executing' && state.testLock,
      'A revision needs an executing Goal with a locked suite',
    );
    requireThat(
      data && commit.safeParse(data.commit).success && data.reason?.trim() && data.by?.trim(),
      'Revision details required',
    );
    return { ...state, pendingRevision: data };
  }
  const lock = lockSchema.parse(event.data);
  if (state.status === 'testing') {
    requireThat(!lock.revisionOf && !state.testLock, 'The first lock cannot be a revision');
    requireThat(state.proposal?.baseCommit, 'A lock needs the proposal base commit');
    return { ...state, status: 'executing', testLock: lock };
  }
  requireThat(
    state.status === 'executing' && state.testLock,
    'Tests are locked only while the Goal is testing or executing',
  );
  requireThat(
    lock.revisionOf?.toLowerCase() === state.testLock.commit.toLowerCase(),
    'A revision must name the lock it replaces',
  );
  const packages = Object.fromEntries(
    Object.entries(state.packages ?? {}).map(([id, item]) => [
      id,
      { spec: item.spec, status: 'pending' as const, attempts: item.attempts },
    ]),
  );
  return {
    ...state,
    testLock: lock,
    testRevisions: (state.testRevisions ?? 0) + 1,
    pendingRevision: undefined,
    packages,
    integration: undefined,
    gate: undefined,
  };
}

/** Counts the lines that hold an assertion. Rough on purpose: it reads lines, not syntax, so it can be fooled. */
export function countAsserts(text: string, patterns: string[]): number {
  const compiled = patterns.map(pattern => new RegExp(pattern));
  return text.split(/\r?\n/).filter(line => compiled.some(re => re.test(line))).length;
}

export type LayerOutcome = { part: string; layer: LockedLayer; tests: TestOutcome[] };
type Patterns = { notImplemented: string[]; loadError: string[] };

const firstLine = (text: string | undefined) =>
  ((text ?? '').split(/\r?\n/).find(line => line.trim()) ?? '').trim().slice(0, 160);
const matchesAnyPattern = (text: string | undefined, patterns: string[]) =>
  patterns.some(pattern => new RegExp(pattern, 'm').test(text ?? ''));

/**
 * Why the suite a tester submitted is not ready to lock; empty when it is. Every mapped test must be in its layer's
 * report (so it loaded). A `red-green` test must be red for the right reason: it failed, or errored with "not
 * implemented"; an error that is a load error, or any other error, does not count. A `stays-green` test must pass.
 * A `removed` test (the feature goes away) must fail on an assertion: the feature is there, and the test says it is not.
 * A test that loaded wrongly anywhere in a mapped layer is a problem even when no criterion names it.
 */
export function judgeSuite(input: {
  map: TestMapEntry[];
  proofOf: (acceptanceId: string) => 'red-green' | 'stays-green' | 'removed' | 'manual' | undefined;
  outcomes: LayerOutcome[];
  patterns: Record<string, Patterns>;
  /** A bugfix test is red because the bug is there: one that is green does not reproduce it. */
  bugfix?: boolean;
  /** A characterize test captures what the code does: it must be green on it as it is. */
  characterize?: boolean;
  /** The tests the Goal declares removed (`<part>.<layer>::<id>`): a test of absence may not share a file with one. */
  declared?: string[];
}): string[] {
  const problems: string[] = [];
  const loadBroken = new Set<string>();
  for (const { part, layer, tests } of input.outcomes) {
    const where = input.patterns[part];
    for (const test of tests) {
      if (
        (test.status === 'error' || test.status === 'fail') &&
        matchesAnyPattern(test.message, where?.loadError ?? [])
      ) {
        problems.push(`${part}.${layer} ${test.id}: the test did not load: ${firstLine(test.message) || test.status}`);
        loadBroken.add(`${part}.${layer}`);
      }
    }
  }
  for (const entry of input.map) {
    const outcome = input.outcomes.find(item => item.part === entry.part && item.layer === entry.layer);
    const proof = input.proofOf(entry.acceptanceId);
    for (const id of entry.testIds) {
      const label = `${entry.acceptanceId} ${entry.part}.${entry.layer} ${id}`;
      if (proof === 'removed') {
        // Locking the file would lock the old tests with it, and the Worker could neither keep them nor delete them.
        const prefix = id.split('::')[0];
        const shares = (outcome?.tests ?? []).some(
          other =>
            other.id.split('::')[0] === prefix &&
            (input.declared ?? []).some(item => entryMatches(item, testKey(entry.part, entry.layer, other.id))),
        );
        if (shares)
          problems.push(
            `${label}: this test of absence is in a file that holds a test the Goal declares removed: put it in a file of its own, or the old tests would be locked with it`,
          );
      }
      const test = outcome?.tests.find(item => item.id === id);
      if (!test) {
        problems.push(
          `${label}: not in the report${loadBroken.has(`${entry.part}.${entry.layer}`) ? ' (a test in this layer did not load)' : ': is the id exactly as the report gives it, and does the file load?'}`,
        );
        continue;
      }
      if (matchesAnyPattern(test.message, input.patterns[entry.part]?.loadError ?? [])) continue;
      if (test.status === 'skip') problems.push(`${label}: skipped`);
      else if (proof === 'stays-green') {
        if (test.status !== 'pass')
          problems.push(
            input.characterize
              ? `${label}: chụp hành vi phải xanh trên code như hiện tại: the test is ${test.status}. Describe what the code does today, odd behaviour included; a wrong-looking result is a note for a later \`apos bug\`, not a failing test`
              : `${label}: a stays-green test must pass, it is ${test.status}`,
          );
      } else if (
        proof === 'removed' &&
        (test.status === 'error' || !failedAnAssertion(test.message, input.patterns[entry.part], test.failureType))
      )
        problems.push(
          `${label}: a test that says the feature is gone must fail on an assertion while it is still there, and it ${test.status === 'error' ? 'errored' : 'raised'}: ${firstLine(test.message) || 'no message'}. Import the code that stays and call the entry the feature was reached by; an import, attribute or type error says nothing about the feature`,
        );
      else if (test.status === 'pass')
        problems.push(
          proof === 'removed'
            ? `${label}: already green: the feature is gone already, or the test never asks for it. A test of absence must fail while the feature is there`
            : input.bugfix
              ? `${label}: the test does not reproduce the bug (test không tái hiện lỗi): it is already green on the current code. Make it fail on the bug, for the reason in the bug report`
              : `${label}: already green: a stub that happens to work, or a test that never calls it. A red-green test must fail first`,
        );
      else if (
        test.status === 'error' &&
        !matchesAnyPattern(test.message, input.patterns[entry.part]?.notImplemented ?? [])
      )
        problems.push(
          `${label}: errored with something other than "not implemented": ${firstLine(test.message) || 'no message'}`,
        );
    }
  }
  return problems;
}

/**
 * Whether a failed test's message reads as an assertion that did not hold, and not as an exception from somewhere else:
 * pytest and JUnit report an `AttributeError` raised in a test body as a failure, like an assertion. Rough on purpose, it
 * reads the first line: an exception class (`TypeError: ...`, `java.lang.NullPointerException`) that is not an assertion
 * one, or a message the stack's patterns call a load error or "not implemented", is not a failed assertion.
 */
export function failedAnAssertion(
  message: string | undefined,
  where: { notImplemented: string[]; loadError: string[] } | undefined,
  failureType?: string,
): boolean {
  if (matchesAnyPattern(message, [...(where?.loadError ?? []), ...(where?.notImplemented ?? [])])) return false;
  // A runner that says the exception class (vitest, Surefire) is believed over the wording of the message.
  if (failureType) return /Assert/.test(failureType);
  const line = firstLine(message);
  // Jest words a failed assertion as `Error: expect(received).toBe(expected)`.
  if (/^\s*(?:Error:\s*)?expect\(/.test(line)) return true;
  return !/^\s*(?:[\w$]+\.)*(?!Assert)\w*(?:Error|Exception)\b/.test(line);
}

/** `<id>:<status>` of every test, sorted: two runs of the same commit must give the same text. */
export const outcomeSignature = (tests: TestOutcome[]): string =>
  tests
    .map(test => `${test.id}:${test.status}`)
    .sort()
    .join('\n');
