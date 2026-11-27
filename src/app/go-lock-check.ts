import { matchesAny, rootedGlobs } from '../domain/glob.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { GoalState } from '../domain/transitions.js';
import { fileAt, filesAt } from './git-files.js';
import { checkGoEntries } from './go-entry.js';

/** A later commit must not introduce an unheld Go helper into a locked test binary. */
export function goLockProblems(repo: string, setup: ProjectSetup, state: GoalState, head: string): string[] {
  const lock = state.testLock;
  if (!lock) return [];
  const parts = new Set(lock.map.filter(entry => entry.layer === 'L2').map(entry => entry.part));
  const applicable = [...parts].filter(name => setup.parts[name]?.tests?.entryRule?.goModule);
  if (!applicable.length) return [];
  const files = filesAt(repo, head);
  const read = (path: string) => fileAt(repo, head, path)?.toString('utf8');
  const stubs = [
    state.proposal?.stubPaths ?? [],
    ...Object.values(state.packages ?? {}).map(item => item.spec.stubPaths ?? []),
  ].flat();
  const problems: string[] = [];
  for (const name of applicable) {
    const part = setup.parts[name]!;
    const testPaths = rootedGlobs(part.root, part.tests!.paths);
    const allowed = (path: string) =>
      matchesAny(path, stubs) ||
      matchesAny(path, testPaths) ||
      (state.spec.kind === 'characterize' && matchesAny(path, state.spec.covers ?? []));
    const module = read(part.root === '.' ? 'go.mod' : `${part.root}/go.mod`) ?? '';
    for (const file of Object.keys(lock.files).filter(
      path => path.endsWith('_test.go') && matchesAny(path, testPaths),
    )) {
      const text = read(file);
      if (text === undefined) continue; // The normal hash check reports deletions.
      problems.push(
        ...checkGoEntries({
          file,
          partRoot: part.root,
          files,
          module,
          text,
          allowed,
          read,
          isTestFile: path => matchesAny(path, testPaths),
          conservativeBuild: true,
          recordHelper: path => {
            if (!Object.hasOwn(lock.files, path)) problems.push(`Go test helper is not locked: ${path}`);
          },
        }),
      );
    }
  }
  return [...new Set(problems)];
}
