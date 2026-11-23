import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertGitRoot } from '../store/project-history.js';

/** The bytes of `path` as committed at `commit`, or undefined when the commit has no such file. */
export function fileAt(repo: string, commit: string, path: string): Buffer | undefined {
  try {
    return execFileSync('git', ['-C', assertGitRoot(repo), 'show', `${commit}:${path}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** sha256 of the bytes as committed, so a rewritten line ending or space shows. */
export const sha256Of = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

/** Every file of the commit's tree, repo-relative with forward slashes. */
export function filesAt(repo: string, commit: string): string[] {
  return execFileSync('git', ['-C', assertGitRoot(repo), 'ls-tree', '-r', '--name-only', '-z', commit], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

/** Every file each commit of `from..to` changed (a merge: what it changed beyond its parents), so a change a later commit puts back is still seen. */
export function filesByCommit(repo: string, from: string, to: string): { commit: string; files: string[] }[] {
  const out = execFileSync(
    'git',
    [
      '-C',
      assertGitRoot(repo),
      '-c',
      'core.quotepath=off',
      'log',
      // -c: a merge shows the files it changed against every parent (an edit made in the merge itself), none for a clean one.
      '-c',
      '--no-renames',
      '--name-only',
      '--format=@@%H',
      `${from}..${to}`,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const commits: { commit: string; files: string[] }[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@@')) commits.push({ commit: line.slice(2), files: [] });
    else if (line) commits.at(-1)?.files.push(line);
  }
  return commits;
}
