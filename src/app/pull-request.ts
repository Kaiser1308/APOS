import { execFileSync } from 'node:child_process';
import { UserError } from '../domain/errors.js';

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * The commit a pull request points at on `remote`, fetched with plain git (`pull/<n>/head`), no `gh`, no API. It is kept
 * under `refs/apos/pr/<n>` so the commit stays in the repo whatever the remote does next.
 */
export function fetchPullRequest(repo: string, remote: string, number: number): string {
  const ref = `refs/apos/pr/${number}`;
  try {
    git(repo, ['fetch', '--quiet', remote, `+pull/${number}/head:${ref}`]);
    return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error ? String((error as { stderr: unknown }).stderr) : '';
    throw new UserError(
      `cannot fetch pull request #${number} from ${remote} (git fetch ${remote} pull/${number}/head): ${detail.trim().split('\n')[0] || 'no such ref'}`,
    );
  }
}

/** The title of the first commit the pull request adds on top of `HEAD`: the default description of a maintenance Goal. */
export function firstCommitTitle(repo: string, sha: string): string {
  const added = git(repo, ['log', '--reverse', '--format=%s', `HEAD..${sha}`]).split('\n')[0];
  return added || git(repo, ['log', '-1', '--format=%s', sha]);
}
