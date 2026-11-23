import { matchesAny, rootedGlobs } from '../domain/glob.js';
import type { ProjectSetup } from '../domain/project-setup.js';

/** The files a tool of `part` may mutate: inside the part, not tests, not APOS's own; paths relative to the part's root. */
export function sourceFilesOf(setup: ProjectSetup, part: string, root: string, files: string[]): string[] {
  const where = setup.parts[part];
  const tests = where?.tests ? rootedGlobs(where.root, where.tests.paths) : [];
  const inside = (file: string) => root === '.' || file === root || file.startsWith(`${root}/`);
  return files
    .filter(file => inside(file) && !matchesAny(file, tests) && !file.startsWith('.apos/'))
    .map(file => (root === '.' ? file : file.slice(root.length + 1)));
}
