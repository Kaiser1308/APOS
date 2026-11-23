import { execFileSync } from 'node:child_process';
import { assertGitRoot } from '../store/project-history.js';
import {
  infraCheck,
  inventoryCheck,
  lockedTestsCheck,
  reviewTestsCheck,
  scopeCheck,
  testSetOf,
  INVENTORY_CHECK,
  REVIEW_CHECK,
  type TestSet,
} from '../domain/assurance.js';
import { reviewOverrideBy } from '../domain/review-tests.js';
import { matchesAny, rootedGlobs } from '../domain/glob.js';
import type { CheckResult } from '../domain/gate.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { LayerOutcome, LockedLayer } from '../domain/test-lock.js';
import type { GoalState, PackageState } from '../domain/transitions.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import { fileAt, filesAt, sha256Of } from './git-files.js';
import type { ToolRunner } from './layer-runner.js';
import type { LayerId } from '../domain/layers.js';
import { LayerGate, type LayerGateInput } from './layer-gate.js';
import { refactorScopeCheck } from '../domain/characterized.js';
import { characterizeScopeCheck, characterizedResult, coverageOfRefactor } from './characterized-gate.js';

export type AssuranceDeps = {
  repo: string;
  runner: ToolRunner;
  inspector: CommitInspector;
  /** The setup the Goal is pinned to, or undefined when it has none (then nothing here applies). */
  loadSetup: (state: GoalState) => ProjectSetup | undefined;
  /** Every Goal of the project, for a refactor to find the characterize Goals it leans on. */
  goals?: () => GoalState[];
};

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

const unverifiable = (checkId: string, reason: string): CheckResult => ({
  checkId,
  status: 'unverifiable',
  reason,
  base: [],
  delivery: [],
  newFailures: [],
});

/**
 * The three checks every package gate adds when its Goal is pinned to a setup: the locked tests are untouched and pass,
 * no test was lost, and no file was changed outside the package's paths. All three read the full runs of the layers
 * (L1 of every part, plus the layers the locked tests live in), once on the base and once on the delivery.
 */
export class AssuranceService {
  private readonly layerGate: LayerGate;
  constructor(private readonly deps: AssuranceDeps) {
    this.layerGate = new LayerGate({ runner: deps.runner, loadSetup: deps.loadSetup });
  }

  /** The layers the stage plans (floor, Lead's, triggers, criteria), run and judged. Empty for a Goal without a setup. */
  layerChecks(state: GoalState, input: LayerGateInput): ReturnType<LayerGate['run']> {
    const ran = this.layerGate.run(state, input);
    // A refactor holds the captured tests at every later stage too: the close stage reads them on the verified commit.
    // The scope the Human approved with a legacy Goal binds the integration commit and the close stage like a package.
    if (input.stage !== 'submit') ran.checks = [...ran.checks, ...this.legacyChecks(state, input)];
    if (input.stage !== 'integrate') return ran;
    ran.checks = [...ran.checks, ...this.integrationChecks(state, input)];
    // A review of the integration commit locks its tests into every later integration commit, like a package's.
    const reviews = (state.reviewTests ?? []).filter(review => !review.packageId);
    const setup = this.deps.loadSetup(state);
    if (!reviews.length || !setup) return ran;
    const wanted = new Map<string, { part: string; layer: LayerId }>();
    for (const review of reviews)
      for (const test of review.tests) wanted.set(`${test.part}.${test.layer}`, { part: test.part, layer: test.layer });
    const delivery = this.runTests(setup, wanted, input.head);
    return { ...ran, checks: [...ran.checks, this.reviewCheck(state, reviews, input.head, delivery)] };
  }

  /** The checks of a characterize or refactor Goal at a stage that sees the whole Goal (the integration commit, the close). */
  private legacyChecks(state: GoalState, input: LayerGateInput): CheckResult[] {
    const setup = this.deps.loadSetup(state);
    if (!setup) return [];
    const lock = state.testLock;
    const reviews = (state.reviewTests ?? []).filter(review => !review.packageId);
    const checks: CheckResult[] = [];
    if (state.spec.kind === 'refactor') {
      const kept = this.characterized(state, input.head, input.base);
      if (kept) checks.push(kept);
      checks.push(
        refactorScopeCheck({
          changed: input.changed,
          paths: state.spec.paths ?? [],
          needsHuman: Object.values(setup.parts).flatMap(part => rootedGlobs(part.root, part.needsHuman)),
          lockedFiles: [...Object.keys(lock?.files ?? {}), ...reviews.flatMap(review => Object.keys(review.files))],
          judged: this.judgedByAPackage(state, input),
        }),
      );
    }
    if (state.spec.kind === 'characterize' && input.base)
      checks.push(characterizeScopeCheck({ repo: this.deps.repo, setup, base: input.base, head: input.head }));
    // What a characterize Goal locked stays as it was locked at these stages too: the integration commit cannot rewrite a captured test.
    // (At the integrate stage `integrationChecks` runs the same locked-tests check for every Goal.)
    if (state.spec.kind === 'characterize' && lock && input.stage !== 'integrate') {
      const wanted = new Map<string, { part: string; layer: LayerId }>();
      for (const entry of lock.map)
        wanted.set(`${entry.part}.${entry.layer}`, { part: entry.part, layer: entry.layer });
      const delivery = this.runTests(setup, wanted, input.head);
      checks.push(
        lockedTestsCheck({
          lock,
          deliveryFiles: Object.fromEntries(
            Object.keys(lock.files).map(path => {
              const content = fileAt(this.deps.repo, input.head, path);
              return [path, content ? sha256Of(content) : undefined];
            }),
          ),
          delivery: delivery.set,
          runProblems: delivery.problems,
          criteria: lock.map.map(entry => entry.acceptanceId),
        }),
      );
    }
    return checks;
  }

  /**
   * What a package gate judges, asked of the integration commit too: the locked tests are untouched and pass (the Goal
   * answers for all of them), test infrastructure is as locked, no test that ran at the base is lost, and every changed
   * file is inside the paths of the green packages or the plan's own `paths` (the integration files it declares).
   */
  private integrationChecks(state: GoalState, input: LayerGateInput): CheckResult[] {
    const setup = this.deps.loadSetup(state);
    if (!setup || !input.base) return [];
    const { repo } = this.deps;
    const lock = state.testLock;
    const reviews = (state.reviewTests ?? []).filter(review => !review.packageId);
    const wanted = new Map<string, { part: string; layer: LayerId }>();
    for (const [part, where] of Object.entries(setup.parts))
      if (where.layers.L1?.length) wanted.set(`${part}.L1`, { part, layer: 'L1' });
    for (const entry of lock?.map ?? [])
      wanted.set(`${entry.part}.${entry.layer}`, { part: entry.part, layer: entry.layer });
    const delivery = this.runTests(setup, wanted, input.head);
    const atBase = this.runTests(setup, wanted, input.base);
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
          runProblems: delivery.problems,
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
      checks.push(infraCheck({ lockInfra: lock.infra, delivery: now }));
    }
    const packages = Object.values(state.packages ?? {});
    const needsHuman = Object.values(setup.parts).flatMap(part => rootedGlobs(part.root, part.needsHuman));
    const judged = new Set(this.judgedByAPackage(state, input));
    checks.push(
      scopeCheck({
        // A sensitive file a package gate judged (same bytes) was decided there; any other one falls to the paths.
        changed: input.changed.filter(file => !(judged.has(file) && matchesAny(file, needsHuman))),
        paths: [
          ...packages.flatMap(item => [...(item.spec.paths ?? []), ...(item.spec.stubPaths ?? [])]),
          ...(state.proposal?.paths ?? []),
          ...(state.proposal?.stubPaths ?? []),
        ],
        needsHuman: [],
        lockedFiles: [...Object.keys(lock?.files ?? {}), ...reviews.flatMap(review => Object.keys(review.files))],
      }),
    );
    return checks;
  }

  /**
   * The changed files whose content at `head` is exactly what a package gate judged (its delivery commit changed them and
   * holds the same bytes): a sensitive file the integration changed again after that is not judged.
   */
  private judgedByAPackage(state: GoalState, input: LayerGateInput): string[] {
    const { repo } = this.deps;
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

  /** The layers the captured tests of a refactor live in, added to `wanted`: the base and the delivery both run them. */
  private capturedLayers(state: GoalState, wanted: Map<string, { part: string; layer: LayerId }>) {
    const coverage = this.deps.goals
      ? coverageOfRefactor(this.deps.repo, this.deps.goals(), state, undefined, this.deps.inspector)
      : undefined;
    for (const { lock } of coverage?.sources ?? [])
      for (const entry of lock.map)
        wanted.set(`${entry.part}.${entry.layer}`, { part: entry.part, layer: entry.layer });
    return coverage;
  }

  /** `APOS-CHARACTERIZED` for a refactor, run on its own (the close and integrate stages have no run to share). */
  private characterized(state: GoalState, head: string, base: string | undefined): CheckResult | undefined {
    if (state.spec.kind !== 'refactor') return undefined;
    const setup = this.deps.loadSetup(state);
    const wanted = new Map<string, { part: string; layer: LayerId }>();
    const coverage = this.capturedLayers(state, wanted);
    if (!setup || !coverage) return undefined;
    const at = base ?? state.proposal?.baseCommit ?? head;
    return characterizedResult({
      repo: this.deps.repo,
      coverage,
      head,
      delivery: this.runTests(setup, wanted, head),
      base: this.runTests(setup, wanted, at),
    });
  }

  /** Every test of the given layers, run once on `commit` in a clean worktree. */
  private runTests(setup: ProjectSetup, wanted: Map<string, { part: string; layer: LayerId }>, commit: string) {
    const outcomes: LayerOutcome[] = [];
    const problems: string[] = [];
    for (const { part, layer } of wanted.values()) {
      const where = setup.parts[part];
      if (!where) continue;
      const result = this.deps.runner.layerTests(commit, part, where.root, layer, where.layers[layer] ?? []);
      problems.push(...result.problems);
      outcomes.push({ part, layer: layer as LockedLayer, tests: result.tests });
    }
    return { set: testSetOf(outcomes) as TestSet, problems };
  }

  /** The reviewers' tests are untouched and pass on `head`, or the review was waived by an exception. */
  private reviewCheck(
    state: GoalState,
    reviews: NonNullable<GoalState['reviewTests']>,
    head: string,
    delivery: { set: TestSet; problems: string[] },
  ): CheckResult {
    const { repo } = this.deps;
    return delivery.problems.length
      ? unverifiable(REVIEW_CHECK, `the layers did not run: ${delivery.problems.join('; ')}`)
      : reviewTestsCheck({
          reviews,
          overriddenBy: review => reviewOverrideBy(state, review),
          deliveryFiles: review =>
            Object.fromEntries(
              Object.keys(review.files).map(path => {
                const content = fileAt(repo, head, path);
                return [path, content ? sha256Of(content) : undefined];
              }),
            ),
          delivery: delivery.set,
        });
  }

  /**
   * Files a green dependency of this package already changed, still byte for byte as that dependency left them: the
   * delivery contains them, so they are not this package's change.
   */
  private inherited(state: GoalState, item: PackageState, head: string, base: string): Set<string> {
    const { repo, inspector } = this.deps;
    const out = new Set<string>();
    const seen = new Set<string>();
    const todo = [...item.spec.dependencies];
    while (todo.length) {
      const id = todo.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const dep = state.packages?.[id];
      if (!dep) continue;
      todo.push(...dep.spec.dependencies);
      const commit = dep.gate?.deliveryCommit;
      if (dep.status !== 'green' || !commit) continue;
      for (const file of inspector.files(repo, commit, base)) {
        const mine = fileAt(repo, head, file);
        const theirs = fileAt(repo, commit, file);
        if (mine?.equals(theirs ?? Buffer.alloc(0)) ? theirs !== undefined : mine === undefined && theirs === undefined)
          out.add(file);
      }
    }
    return out;
  }

  checks(state: GoalState, item: PackageState, head: string, base: string, changed: string[]): CheckResult[] {
    const setup = this.deps.loadSetup(state);
    if (!setup) return [];
    const { repo } = this.deps;
    const lock = state.testLock;
    const reviews = (state.reviewTests ?? []).filter(review => review.packageId === item.spec.id);
    const wanted = new Map<string, { part: string; layer: LayerId }>();
    for (const [part, where] of Object.entries(setup.parts))
      if (where.layers.L1?.length) wanted.set(`${part}.L1`, { part, layer: 'L1' });
    for (const entry of lock?.map ?? [])
      wanted.set(`${entry.part}.${entry.layer}`, { part: entry.part, layer: entry.layer });

    for (const review of reviews)
      for (const test of review.tests) wanted.set(`${test.part}.${test.layer}`, { part: test.part, layer: test.layer });

    const coverage = state.spec.kind === 'refactor' ? this.capturedLayers(state, wanted) : undefined;
    const run = (commit: string) => this.runTests(setup, wanted, commit);
    const delivery = run(head);
    const atBase = run(base);
    const checks: CheckResult[] = [];
    if (coverage) checks.push(characterizedResult({ repo, coverage, head, delivery, base: atBase }));
    if (state.spec.kind === 'characterize') checks.push(characterizeScopeCheck({ repo, setup, base, head }));

    if (lock) {
      const deliveryFiles = Object.fromEntries(
        Object.keys(lock.files).map(path => {
          const content = fileAt(repo, head, path);
          return [path, content ? sha256Of(content) : undefined];
        }),
      );
      checks.push(
        lockedTestsCheck({
          lock,
          deliveryFiles,
          delivery: delivery.set,
          runProblems: delivery.problems,
          criteria: item.spec.acceptance.flatMap(criterion =>
            criterion.goalAcceptanceId ? [criterion.goalAcceptanceId] : [],
          ),
        }),
      );
    }
    if (reviews.length) checks.push(this.reviewCheck(state, reviews, head, delivery));
    const problems = [...delivery.problems, ...atBase.problems];
    checks.push(
      problems.length
        ? unverifiable(INVENTORY_CHECK, `the layers did not run: ${problems.join('; ')}`)
        : inventoryCheck({
            base: atBase.set,
            delivery: delivery.set,
            addedLines: addedLines(repo, base, head),
            forbid: Object.values(setup.parts).flatMap(part => part.forbid),
          }),
    );
    const inherited = this.inherited(state, item, head, base);
    if (lock?.infra) {
      const globs = Object.values(setup.parts).flatMap(part => rootedGlobs(part.root, part.tests?.infra ?? []));
      const now: Record<string, string> = {};
      for (const file of filesAt(repo, head))
        if (matchesAny(file, globs)) {
          const content = fileAt(repo, head, file);
          if (content) now[file] = sha256Of(content);
        }
      checks.push(infraCheck({ lockInfra: lock.infra, delivery: now, inherited }));
    }
    if (state.spec.kind === 'refactor')
      checks.push(
        refactorScopeCheck({
          changed: changed.filter(file => !inherited.has(file)),
          paths: state.spec.paths ?? [],
          needsHuman: Object.values(setup.parts).flatMap(part => rootedGlobs(part.root, part.needsHuman)),
          lockedFiles: [...Object.keys(lock?.files ?? {}), ...reviews.flatMap(review => Object.keys(review.files))],
          // This is the package gate: APOS-SCOPE below judges the sensitive files, with an approval route.
          judged: changed,
        }),
      );
    const paths = item.spec.paths;
    if (paths?.length)
      checks.push(
        scopeCheck({
          changed: changed.filter(file => !inherited.has(file)),
          paths: [...paths, ...(item.spec.stubPaths ?? [])],
          needsHuman: Object.values(setup.parts).flatMap(part => rootedGlobs(part.root, part.needsHuman)),
          lockedFiles: [...Object.keys(lock?.files ?? {}), ...reviews.flatMap(review => Object.keys(review.files))],
        }),
      );
    return checks;
  }
}
