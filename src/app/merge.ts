import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { GoalRepository } from '../store/journal.js';
import { assertGitRoot } from '../store/project-history.js';

const git = (repo: string, args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export class MergeService {
  constructor(private readonly store: GoalRepository) {}

  /** Records the Human's one-time permission to merge the gated commit into one branch. */
  authorize(goalId: string, targetBranch: string, by: string): void {
    const state = this.store.getGoal(goalId);
    if (!state?.gate) throw new Error('Verified Goal with a controller gate required');
    // Seen live: the merge failed (wrong branch, dirty tree) after this was recorded, and the re-run was refused. The same authorization stands.
    const prior = state.mergeAuthorization;
    if (prior && !state.merge && prior.targetBranch === targetBranch && prior.integrationCommit.toLowerCase() === state.gate.deliveryCommit.toLowerCase()) return;
    this.store.append({ id: randomUUID(), goalId, type: 'merge-authorized', data: { goalId, goalVersion: state.spec.version, integrationCommit: state.gate.deliveryCommit, targetBranch, scope: 'goal', once: true, by }, at: new Date().toISOString() });
  }

  /** Merges exactly the authorized, gated commit into the authorized branch; nothing else. */
  merge(goalId: string, repoPath: string, sourceRef: string, targetBranch: string): string {
    const state = this.store.getGoal(goalId);
    const auth = state?.mergeAuthorization;
    if (state?.status !== 'verified' || !auth || state.merge) throw new Error('Verified Goal with unused Human merge authorization required');
    if (!/^[0-9a-fA-F]{40,64}$/.test(sourceRef ?? '')) throw new Error('Full source commit hash required');
    if (state.gate?.result !== 'green' || state.gate.deliveryCommit.toLowerCase() !== sourceRef.toLowerCase() || auth.integrationCommit.toLowerCase() !== sourceRef.toLowerCase()) throw new Error('Source must be the commit the controller gate verified');
    if (auth.targetBranch !== targetBranch) throw new Error(`Authorization covers ${auth.targetBranch}, not ${targetBranch}`);
    if (state.proposal?.mode === 'multi-wp' && state.integration?.commitRef !== sourceRef) throw new Error('Source must be the verified integration commit');
    const repo = assertGitRoot(repoPath);
    if (git(repo, ['branch', '--show-current']) !== targetBranch) throw new Error('Checkout the authorized target branch before merge');
    if (git(repo, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Working tree must be clean before merge');
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
