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
