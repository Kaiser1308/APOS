import { execFileSync } from 'node:child_process';

/**
 * A package that depends on others must see their delivered code. Builds (without touching any checkout)
 * a commit whose parents are the repo head and the verified dependency commits, with their merged tree.
 */
export function composeBase(repoPath: string, head: string, commits: string[], packageId: string): string {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'APOS',
        GIT_AUTHOR_EMAIL: 'apos@localhost',
        GIT_COMMITTER_NAME: 'APOS',
        GIT_COMMITTER_EMAIL: 'apos@localhost',
      },
    }).trim();
  let current = head;
  for (const commit of [...new Set(commits)]) {
    if (gitOk(repoPath, ['merge-base', '--is-ancestor', commit, current])) continue;
    const tree = git(['merge-tree', '--write-tree', current, commit]).split(/\r?\n/)[0];
    current = git([
      'commit-tree',
      tree,
      '-p',
      current,
      '-p',
      commit,
      '-m',
      `apos: base for ${packageId} with verified dependencies`,
    ]);
  }
  return current;
}

function gitOk(repoPath: string, args: string[]): boolean {
  try {
    execFileSync('git', ['-C', repoPath, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
