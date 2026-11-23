import type { GoalSpec } from './contracts.js';
import { testKey, type TestLock } from './test-lock.js';

/** One old test (or file of tests) a criterion of the Goal says goes away. */
export type RemovedTest = { acceptanceId: string; entry: string };

/** Every test the `removed` criteria of a Goal declare, with the criterion that declares it. */
export const removalOf = (goal: GoalSpec): RemovedTest[] =>
  goal.acceptance.flatMap(item => (item.removesTests ?? []).map(entry => ({ acceptanceId: item.id, entry })));

/** The declared tests of the given criteria only: a package answers for its own. */
export const removalEntries = (goal: GoalSpec, acceptanceIds: string[]): RemovedTest[] =>
  removalOf(goal).filter(item => acceptanceIds.includes(item.acceptanceId));

/**
 * Whether a declared test covers a test key (`<part>.<layer>::<id>`): the same id, every test of a file (`<file>::<name>`),
 * a repeated id (`#2`) or a parametrized one (`name[...]`). A neighbour that merely starts with the same letters is not covered.
 */
export const entryMatches = (entry: string, key: string): boolean =>
  key === entry || ['::', '#', '['].some(next => key.startsWith(entry + next));

/**
 * Why a Goal's removed tests cannot be approved against a base: the layer is not one the base ran, or the declared test
 * (or file) is not among the tests the layer reported. `ran` maps `<part>.<layer>` to the test keys of the base run.
 */
export function removalProblems(goal: GoalSpec, ran: Record<string, string[]>): string[] {
  const problems: string[] = [];
  for (const { acceptanceId, entry } of removalOf(goal)) {
    const layer = entry.slice(0, entry.indexOf('::'));
    const keys = ran[layer];
    if (!keys)
      problems.push(
        `${acceptanceId} ${entry}: the base has no test run for ${layer} (a part or layer the setup does not run)`,
      );
    else if (!keys.some(key => entryMatches(entry, key)))
      problems.push(`${acceptanceId} ${entry}: no such test on the base (the id is as the layer report gives it)`);
  }
  return problems;
}

/**
 * A lock as it stands once a Goal removed tests: the tests it declared are no longer pinned (an entry left with none goes),
 * and each file it changed is held as that Goal left it (`files`: the new hash, or undefined when the file was deleted).
 */
export function withoutRemoved(
  lock: TestLock,
  removed: RemovedTest[],
  files: Record<string, string | undefined>,
): TestLock {
  const map = lock.map
    .map(entry => ({
      ...entry,
      testIds: entry.testIds.filter(
        id => !removed.some(item => entryMatches(item.entry, testKey(entry.part, entry.layer, id))),
      ),
    }))
    .filter(entry => entry.testIds.length);
  const held = Object.fromEntries(
    Object.entries(lock.files).flatMap(([path, hash]) =>
      path in files ? (files[path] === undefined ? [] : [[path, files[path]]]) : [[path, hash]],
    ),
  );
  return { ...lock, map, files: held };
}
