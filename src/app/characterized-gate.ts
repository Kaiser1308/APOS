import { characterizedCheck } from '../domain/characterized.js';
import type { TestSet } from '../domain/assurance.js';
import type { CheckResult } from '../domain/gate.js';
import { characterizations, refactorCoverage, type Coverage } from '../domain/legacy.js';
import type { GoalState } from '../domain/transitions.js';
import { rootedGlobs, matchesAny } from '../domain/glob.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import { fileAt, filesAt, filesByCommit, sha256Of } from './git-files.js';

/**
 * Which closed characterize Goals a refactor leans on: those that cover a file its `paths` reach, read from the files the
 * plan's base commit holds. Empty `sources` when the Goal is not a refactor or has no base yet.
 */
export function coverageOfRefactor(
  repo: string,
  goals: GoalState[],
  state: GoalState,
  base: string | undefined = state.proposal?.baseCommit,
  /** At the gate: only the characterize Goals whose tests the plan's base already holds count, so a Goal closed after the plan cannot turn it red. */
  inspector?: CommitInspector,
): Coverage {
  const paths = state.spec.kind === 'refactor' ? (state.spec.paths ?? []) : [];
  const held = characterizations(goals).filter(
    item => !inspector || !base || inspector.contains(repo, item.lock.commit, base),
  );
  const coverage = refactorCoverage({ paths, files: base ? filesAt(repo, base) : [], characterized: held });
  // The oldest lock first: where two Goals locked the same file the newest version is the one a delivery must hold.
  if (inspector)
    coverage.sources.sort((a, b) =>
      inspector.contains(repo, a.lock.commit, b.lock.commit)
        ? -1
        : inspector.contains(repo, b.lock.commit, a.lock.commit)
          ? 1
          : 0,
    );
  return coverage;
}

/** The check of `APOS-CHARACTERIZED` on a delivery, from the two runs of the layers the captured tests live in. */
export function characterizedResult(input: {
  repo: string;
  coverage: Coverage;
  head: string;
  delivery: { set: TestSet; problems: string[] };
  base: { set: TestSet; problems: string[] };
}): CheckResult {
  const deliveryFiles: Record<string, string | undefined> = {};
  for (const { lock } of input.coverage.sources)
    for (const path of Object.keys(lock.files)) {
      const content = fileAt(input.repo, input.head, path);
      deliveryFiles[path] = content ? sha256Of(content) : undefined;
    }
  return characterizedCheck({
    sources: input.coverage.sources,
    deliveryFiles,
    delivery: input.delivery.set,
    base: input.base.set,
    runProblems: [...input.delivery.problems, ...input.base.problems],
  });
}

export const CHARACTERIZE_CHECK = 'APOS-CHARACTERIZE';

/**
 * A characterize Goal changes no code, in any commit: the files each commit from the lock to the delivery changed are all
 * tests (or APOS's own). The net diff is judged by the package scope; this also catches code changed and put back.
 */
export function characterizeScopeCheck(input: {
  repo: string;
  setup: ProjectSetup;
  base: string;
  head: string;
}): CheckResult {
  const tests = Object.values(input.setup.parts).filter(part => part.tests);
  const testGlobs = tests.flatMap(part => rootedGlobs(part.root, part.tests!.paths));
  const infraGlobs = tests.flatMap(part => rootedGlobs(part.root, part.tests!.infra));
  const problems: string[] = [];
  for (const item of filesByCommit(input.repo, input.base, input.head))
    for (const file of item.files)
      if (!file.startsWith('.apos/') && (!matchesAny(file, testGlobs) || matchesAny(file, infraGlobs)))
        problems.push(`${file} (commit ${item.commit.slice(0, 7)})`);
  return {
    checkId: CHARACTERIZE_CHECK,
    status: problems.length ? 'fail' : 'pass',
    reason: problems.length
      ? `a characterize Goal changes tests only, in every commit: ${[...new Set(problems)].join(', ')}`
      : 'every commit since the lock changed tests only',
    base: [],
    delivery: [],
    newFailures: [],
  };
}
