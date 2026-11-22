import { execFileSync } from 'node:child_process';
import { assertGitRoot } from '../store/project-history.js';
import {
  infraCheck,
  inventoryCheck,
  lockedTestsCheck,
  scopeCheck,
  testSetOf,
  INVENTORY_CHECK,
  type TestSet,
} from '../domain/assurance.js';
import { matchesAny, rootedGlobs } from '../domain/glob.js';
import type { CheckResult } from '../domain/gate.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { LayerOutcome, LockedLayer } from '../domain/test-lock.js';
import type { GoalState, PackageState } from '../domain/transitions.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import { fileAt, filesAt, sha256Of } from './git-files.js';
import type { ToolRunner } from './layer-runner.js';

export type AssuranceDeps = {
  repo: string;
  runner: ToolRunner;
  inspector: CommitInspector;
  /** The setup the Goal is pinned to, or undefined when it has none (then nothing here applies). */
  loadSetup: (state: GoalState) => ProjectSetup | undefined;
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
  constructor(private readonly deps: AssuranceDeps) {}

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
    const { repo, runner } = this.deps;
    const lock = state.testLock;
    const wanted = new Map<string, { part: string; layer: LockedLayer | 'L1' }>();
    for (const [part, where] of Object.entries(setup.parts))
      if (where.layers.L1?.length) wanted.set(`${part}.L1`, { part, layer: 'L1' });
    for (const entry of lock?.map ?? [])
      wanted.set(`${entry.part}.${entry.layer}`, { part: entry.part, layer: entry.layer });

    const run = (commit: string) => {
      const outcomes: LayerOutcome[] = [];
      const problems: string[] = [];
      for (const { part, layer } of wanted.values()) {
        const where = setup.parts[part];
        if (!where) continue;
        const result = runner.layerTests(commit, part, where.root, layer, where.layers[layer] ?? []);
        problems.push(...result.problems);
        outcomes.push({ part, layer: layer as LockedLayer, tests: result.tests });
      }
      return { set: testSetOf(outcomes) as TestSet, problems };
    };
    const delivery = run(head);
    const atBase = run(base);
    const checks: CheckResult[] = [];

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
    const paths = item.spec.paths;
    if (paths?.length)
      checks.push(
        scopeCheck({
          changed: changed.filter(file => !inherited.has(file)),
          paths: [...paths, ...(item.spec.stubPaths ?? [])],
          needsHuman: Object.values(setup.parts).flatMap(part => rootedGlobs(part.root, part.needsHuman)),
          lockedFiles: Object.keys(lock?.files ?? {}),
        }),
      );
    return checks;
  }
}
