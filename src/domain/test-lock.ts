import { z } from 'zod';
import { InvariantError } from './errors.js';
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
 * A test that loaded wrongly anywhere in a mapped layer is a problem even when no criterion names it.
 */
export function judgeSuite(input: {
  map: TestMapEntry[];
  proofOf: (acceptanceId: string) => 'red-green' | 'stays-green' | 'manual' | undefined;
  outcomes: LayerOutcome[];
  patterns: Record<string, Patterns>;
  /** A bugfix test is red because the bug is there: one that is green does not reproduce it. */
  bugfix?: boolean;
  /** A characterize test captures what the code does: it must be green on it as it is. */
  characterize?: boolean;
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
      } else if (test.status === 'pass')
        problems.push(
          input.bugfix
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

/** `<id>:<status>` of every test, sorted: two runs of the same commit must give the same text. */
export const outcomeSignature = (tests: TestOutcome[]): string =>
  tests
    .map(test => `${test.id}:${test.status}`)
    .sort()
    .join('\n');
