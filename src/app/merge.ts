import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Evidence } from '../domain/contracts.js';
import type { GoalRepository } from '../store/journal.js';
import { assertGitRoot } from '../store/project-history.js';

const git = (repo: string, args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export class MergeService {
  constructor(private readonly store: GoalRepository) {}

  merge(goalId: string, repoPath: string, sourceRef: string, targetBranch: string): string {
    const state = this.store.getGoal(goalId);
    if (state?.status !== 'verified' || !state.spec.autoMergeAuthorized || state.merge) throw new Error('Verified Goal with unused Human merge authorization required');
    if (!sourceRef?.trim() || !targetBranch?.trim()) throw new Error('Source commit and target branch required');
    if (!/^[0-9a-fA-F]{40,64}$/.test(sourceRef)) throw new Error('Full source commit hash required');
    if (state.proposal?.mode === 'multi-wp') {
      if (state.integration?.commitRef !== sourceRef) throw new Error('Source must be the verified integration commit');
    } else {
      const latest = new Map((state.evidence as Evidence[]).map(item => [item.acceptanceId, item]));
      if (!state.spec.acceptance.every(item => latest.get(item.id)?.result === 'pass' && latest.get(item.id)?.commitRef === sourceRef)) throw new Error('Solo source commit must match all verified acceptance evidence');
    }
    const repo = assertGitRoot(repoPath);
    if (git(repo, ['branch', '--show-current']) !== targetBranch) throw new Error('Checkout the authorized target branch before merge');
    if (git(repo, ['status', '--porcelain'])) throw new Error('Working tree must be clean before merge');
    try { git(repo, ['cat-file', '-e', `${sourceRef}^{commit}`]); }
    catch { throw new Error('Source commit does not exist'); }
    let commit = git(repo, ['rev-parse', 'HEAD']);
    try { git(repo, ['merge-base', '--is-ancestor', sourceRef, 'HEAD']); }
    catch {
      try {
        git(repo, ['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'merge', '--no-ff', '--no-edit', sourceRef]);
        commit = git(repo, ['rev-parse', 'HEAD']);
      } catch (error) {
        try { git(repo, ['merge', '--abort']); } catch { /* No merge in progress. */ }
        throw new Error(`Git merge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.store.append({ id: randomUUID(), goalId, type: 'merge-completed', data: { sourceRef, targetBranch, mergeCommit: commit }, at: new Date().toISOString() });
    return commit;
  }
}
