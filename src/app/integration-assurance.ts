import { goLockProblems } from './go-lock-check.js';
import { execFileSync } from 'node:child_process';
import { assertGitRoot } from '../store/project-history.js';
import {
  infraCheck,
  inventoryCheck,
  lockedTestsCheck,
  scopeCheck,
  INVENTORY_CHECK,
  type TestSet,
} from '../domain/assurance.js';
import { reviewOverrideBy } from '../domain/review-tests.js';
import { matchesAny, rootedGlobs } from '../domain/glob.js';
import type { CheckResult } from '../domain/gate.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { LayerId } from '../domain/layers.js';
import type { GoalState } from '../domain/transitions.js';
import { fileAt, filesAt, sha256Of } from './git-files.js';
import type { LayerGateInput } from './layer-gate.js';
import { inventoryLayers, lockedByOthers, type TestRun } from './removal-gate.js';
import { removalOf, type RemovedTest } from '../domain/removal.js';

/** Lines a diff adds, outside `.apos/`, without the `+` marker. */
export function addedLines(repo: string, base: string, head: string): string[] {
  const diff = execFileSync(
    'git',
    ['-C', assertGitRoot(repo), 'diff', '-U0', '--no-color', '--no-ext-diff', base, head, '--', '.', ':!.apos'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return diff
    .split(/\r?\n/)
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1));
}

export const unverifiable = (checkId: string, reason: string): CheckResult => ({
  checkId,
  status: 'unverifiable',
  reason,
  base: [],
  delivery: [],
  newFailures: [],
});

/** What the integration checks need: the repo, the Goal's setup, and a run of the wanted layers on a commit. */
export type IntegrationContext = {
  repo: string;
  setup: ProjectSetup;
  /** Every Goal of the project: a test removed on purpose says whose lock it was. */
  goals?: () => GoalState[];
  runTests: (
    setup: ProjectSetup,
    wanted: Map<string, { part: string; layer: LayerId }>,
    commit: string,
  ) => { set: TestSet; problems: string[] };
};

/**
 * Review tests a package locked (they may sit outside its paths) that the integration holds byte for byte: as the
 * reviewer wrote them, or, once the review was waived, as the green package delivered them.
 */
export function unchangedPackageReviewFiles(repo: string, state: GoalState, head: string): string[] {
  return (state.reviewTests ?? [])
    .filter(review => review.packageId)
    .flatMap(review => {
      const delivery = state.packages?.[review.packageId ?? '']?.gate?.deliveryCommit;
      const waived = delivery && reviewOverrideBy(state, review) !== undefined;
      return Object.entries(review.files).flatMap(([path, hash]) => {
        const now = fileAt(repo, head, path);
        if (!now) return [];
        const delivered = waived ? fileAt(repo, delivery, path) : undefined;
        return sha256Of(now) === hash || delivered?.equals(now) ? [path] : [];
      });
    });
}

/**
 * What a package gate judges, asked of the integration commit too: the locked tests are untouched and pass (the Goal
 * answers for all of them), test infrastructure is as locked, no test that ran at the base is lost, and every changed
 * file is inside the paths of the green packages or the plan's own `paths` (the integration files it declares).
 */
export function integrationChecks(
  { repo, setup, runTests, goals }: IntegrationContext,
  state: GoalState,
  input: LayerGateInput,
): CheckResult[] {
  if (!input.base) return [];
  const lock = state.testLock;
  const reviews = (state.reviewTests ?? []).filter(review => !review.packageId);
  // The Goal as a whole answers for every test it declared removed, whichever package took it out.
  const removable = removalOf(state.spec);
  const wanted = inventoryLayers(setup, lock, removable);
  const delivery = runTests(setup, wanted, input.head);
  const atBase = runTests(setup, wanted, input.base);
  const checks: CheckResult[] = [];
  if (lock)
    checks.push(
      lockedTestsCheck({
        lock,
        deliveryFiles: Object.fromEntries(
          Object.keys(lock.files).map(path => {
            const content = fileAt(repo, input.head, path);
            return [path, content ? sha256Of(content) : undefined];
          }),
        ),
        delivery: delivery.set,
        runProblems: [...delivery.problems, ...goLockProblems(repo, setup, state, input.head)],
        criteria: lock.map.map(entry => entry.acceptanceId),
      }),
    );
  const problems = [...delivery.problems, ...atBase.problems];
  checks.push(
    problems.length
      ? unverifiable(INVENTORY_CHECK, `the layers did not run: ${problems.join('; ')}`)
      : inventoryCheck({
          base: atBase.set,
          delivery: delivery.set,
          addedLines: addedLines(repo, input.base, input.head),
          forbid: Object.values(setup.parts).flatMap(part => part.forbid),
          removable,
          lockedBy: lockedByOthers(goals?.(), state.spec.id),
        }),
  );
  if (lock?.infra) {
    const globs = Object.values(setup.parts).flatMap(part => rootedGlobs(part.root, part.tests?.infra ?? []));
    const now: Record<string, string> = {};
    for (const file of filesAt(repo, input.head))
      if (matchesAny(file, globs)) {
        const content = fileAt(repo, input.head, file);
        if (content) now[file] = sha256Of(content);
      }
    // Infrastructure a green package changed and had approved, byte for byte, is decided; a new change is not.
    checks.push(
      infraCheck({ lockInfra: lock.infra, delivery: now, inherited: new Set(judgedByAPackage(repo, state, input)) }),
    );
  }
  const packages = Object.values(state.packages ?? {});
  const needsHuman = Object.values(setup.parts).flatMap(part => rootedGlobs(part.root, part.needsHuman));
  const judged = new Set(judgedByAPackage(repo, state, input));
  // Infrastructure the tester locked, held byte for byte, is APOS-INFRA's to judge (it came with the lock commit).
  const heldInfra = Object.entries(lock?.infra ?? {}).flatMap(([path, hash]) => {
    const now = fileAt(repo, input.head, path);
    return now && sha256Of(now) === hash ? [path] : [];
  });
  const locked = new Set([
    ...Object.keys(lock?.files ?? {}),
    ...reviews.flatMap(review => Object.keys(review.files)),
    ...unchangedPackageReviewFiles(repo, state, input.head),
    ...heldInfra,
  ]);
  // Tester-owned files (the lock commit's) are APOS-LOCKED's to judge, not sensitive-file decisions of a package.
  const sensitive = input.changed.filter(
    file => !locked.has(file) && !file.startsWith('.apos/') && matchesAny(file, needsHuman),
  );
  // A sensitive file a package gate judged (same bytes) was decided there. Any other one was changed by the integration
  // itself: there is no approval route at this stage, so it is red (the change goes through a package).
  const undecided = sensitive.filter(file => !judged.has(file));
  const scope = scopeCheck({
    changed: input.changed.filter(file => !sensitive.includes(file)),
    paths: [
      ...packages.flatMap(item => [...(item.spec.paths ?? []), ...(item.spec.stubPaths ?? [])]),
      ...(state.proposal?.paths ?? []),
      ...(state.proposal?.stubPaths ?? []),
    ],
    needsHuman: [],
    lockedFiles: [
      ...Object.keys(lock?.files ?? {}),
      ...reviews.flatMap(review => Object.keys(review.files)),
      ...unchangedPackageReviewFiles(repo, state, input.head),
      ...heldInfra,
    ],
  });
  checks.push(
    undecided.length
      ? {
          ...scope,
          status: 'fail',
          reason: `${scope.status === 'fail' ? `${scope.reason}; ` : ''}sensitive file(s) changed by the integration itself, which no package gate decided: ${undecided.join(', ')}`,
        }
      : scope,
  );
  return checks;
}

/**
 * The changed files whose content at `head` is exactly what a package gate judged (its delivery commit changed them and
 * holds the same bytes): a sensitive file the integration changed again after that is not judged.
 */
export function judgedByAPackage(repo: string, state: GoalState, input: LayerGateInput): string[] {
  const gates = Object.values(state.packages ?? {}).flatMap(item => (item.gate ? [item.gate] : []));
  return input.changed.filter(file => {
    const now = fileAt(repo, input.head, file);
    return gates.some(gate => {
      if (!gate.changedFiles?.includes(file)) return false;
      const then = fileAt(repo, gate.deliveryCommit, file);
      return now === undefined ? then === undefined : then?.equals(now) === true;
    });
  });
}

/**
 * The inventory a Goal with `removed` criteria answers for at the close stage, on the commit it was verified on: the other
 * stages that take an inventory (package, integration) do not run there. Without removals the close stage asks nothing new.
 */
export function closeInventory(input: {
  repo: string;
  setup: ProjectSetup;
  state: GoalState;
  removable: RemovedTest[];
  base: string | undefined;
  head: string;
  goals: GoalState[] | undefined;
  runTests: TestRun;
}): CheckResult[] {
  const { setup, state, removable, base, head } = input;
  if (!removable.length || !base) return [];
  const wanted = inventoryLayers(setup, state.testLock, removable);
  const delivery = input.runTests(setup, wanted, head);
  const atBase = input.runTests(setup, wanted, base);
  const problems = [...delivery.problems, ...atBase.problems];
  if (problems.length) return [unverifiable(INVENTORY_CHECK, `the layers did not run: ${problems.join('; ')}`)];
  return [
    inventoryCheck({
      base: atBase.set,
      delivery: delivery.set,
      addedLines: addedLines(input.repo, base, head),
      forbid: Object.values(setup.parts).flatMap(part => part.forbid),
      removable,
      lockedBy: lockedByOthers(input.goals, state.spec.id),
    }),
  ];
}
