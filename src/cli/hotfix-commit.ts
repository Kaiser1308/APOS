import { execFileSync } from 'node:child_process';
import { UserError } from '../domain/errors.js';

const SHA = /^[0-9a-fA-F]{40,64}$/;

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const succeeds = (repo: string, args: string[]): boolean => {
  try {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const fullCommit = (repo: string, flag: string, sha: string): string => {
  if (!SHA.test(sha)) throw new UserError(`${flag} takes the full sha of a commit`);
  if (!succeeds(repo, ['cat-file', '-e', `${sha}^{commit}`]))
    throw new UserError(`${flag} ${sha} is not a commit of this repository`);
  return sha.toLowerCase();
};

/**
 * The commit the Human lets through and the commit "before" it, which the bug is reproduced on. A plain commit has one
 * parent and that is `before`. A merge commit or a root commit has no single "before": the Human says which with
 * `--before`, which must be an older commit of the hotfix. `changed` is what the hotfix changed from `before`.
 */
export function hotfixRange(
  repo: string,
  commitArg: string,
  beforeArg?: string,
): { commit: string; before: string; changed: string[] } {
  const commit = fullCommit(repo, '--commit', commitArg);
  let before: string;
  if (beforeArg !== undefined) {
    before = fullCommit(repo, '--before', beforeArg);
    if (before === commit) throw new UserError('--before is the hotfix commit itself: it must be a commit before it');
    if (!succeeds(repo, ['merge-base', '--is-ancestor', before, commit]))
      throw new UserError(`--before ${before} is not an ancestor of the hotfix commit ${commit}`);
  } else {
    const parents = git(repo, ['rev-list', '--parents', '-n', '1', commit]).split(/\s+/).slice(1).filter(Boolean);
    if (parents.length !== 1)
      throw new UserError(
        `${commit} ${parents.length ? `is a merge commit (${parents.length} parents)` : 'has no parent'}: say which commit is "before" the hotfix with --before <sha> (an ancestor of it)`,
      );
    before = parents[0]!.toLowerCase();
  }
  const changed = git(repo, ['diff', '--name-only', '--no-renames', before, commit]).split(/\r?\n/).filter(Boolean);
  if (!changed.length)
    throw new UserError(`the hotfix ${commit} changes no file from ${before}: there is nothing to prove`);
  return { commit, before, changed };
}
