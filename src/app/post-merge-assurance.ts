import { infraCheck, lockedTestsCheck, type TestSet } from '../domain/assurance.js';
import { matchesAny, rootedGlobs } from '../domain/glob.js';
import type { CheckResult } from '../domain/gate.js';
import type { LayerId } from '../domain/layers.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { GoalState } from '../domain/transitions.js';
import { goLockProblems } from './go-lock-check.js';
import { fileAt, filesAt, sha256Of } from './git-files.js';

/** Protect the verified test contract against independent target-branch changes. */
export function postMergeAssurance(input: {
  repo: string;
  setup: ProjectSetup;
  state: GoalState;
  head: string;
  verified: string;
  runTests: (
    setup: ProjectSetup,
    wanted: Map<string, { part: string; layer: LayerId }>,
    commit: string,
  ) => { set: TestSet; problems: string[] };
}): CheckResult[] {
  const { repo, setup, state, head, verified } = input;
  const lock = state.testLock;
  if (!lock) return [];
  const wanted = new Map<string, { part: string; layer: LayerId }>();
  for (const entry of lock.map) wanted.set(`${entry.part}.${entry.layer}`, { part: entry.part, layer: entry.layer });
  const delivery = input.runTests(setup, wanted, head);
  const checks = [
    lockedTestsCheck({
      lock,
      deliveryFiles: Object.fromEntries(
        Object.keys(lock.files).map(path => {
          const content = fileAt(repo, head, path);
          return [path, content ? sha256Of(content) : undefined];
        }),
      ),
      delivery: delivery.set,
      runProblems: [...delivery.problems, ...goLockProblems(repo, setup, state, head)],
      criteria: lock.map.map(entry => entry.acceptanceId),
    }),
  ];
  if (lock.infra) {
    const globs = Object.values(setup.parts).flatMap(part => rootedGlobs(part.root, part.tests?.infra ?? []));
    const snapshot = (commit: string) =>
      Object.fromEntries(
        filesAt(repo, commit)
          .filter(path => matchesAny(path, globs))
          .map(path => {
            const content = fileAt(repo, commit, path);
            if (!content) throw new Error(`Cannot read test infrastructure ${path} at ${commit}`);
            return [path, sha256Of(content)];
          }),
      );
    checks.push(infraCheck({ lockInfra: snapshot(verified), delivery: snapshot(head) }));
  }
  return checks;
}
