import { execFileSync } from 'node:child_process';
import { newEvent } from './events.js';
import { validatePackageGraph } from '../domain/packages.js';
import { assertGitRoot } from '../store/project-history.js';
import { VerificationService } from './verification.js';
import { UserError } from '../domain/errors.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { CommitInspector } from '../ports/commit-inspector.js';

export class GitCommitInspector implements CommitInspector {
  exists(repoPath: string, ref: string): boolean {
    if (!/^[0-9a-fA-F]{40,64}$/.test(ref)) return false;
    try {
      execFileSync('git', ['-C', assertGitRoot(repoPath), 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  files(repoPath: string, ref: string, baseCommit?: string): string[] {
    if (!/^[0-9a-fA-F]{40,64}$/.test(ref)) throw new Error('Full commit hash required');
    if (baseCommit) {
      if (!/^[0-9a-fA-F]{40,64}$/.test(baseCommit)) throw new Error('Full package base commit required');
      return execFileSync(
        'git',
        ['-C', assertGitRoot(repoPath), 'diff', '--name-only', '--no-renames', baseCommit, ref],
        {
          encoding: 'utf8',
        },
      )
        .split(/\r?\n/)
        .filter(Boolean);
    }
    return execFileSync(
      'git',
      ['-C', assertGitRoot(repoPath), 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', ref],
      { encoding: 'utf8' },
    )
      .split(/\r?\n/)
      .filter(Boolean);
  }
  contains(repoPath: string, ancestor: string, descendant: string): boolean {
    if (![ancestor, descendant].every(ref => /^[0-9a-fA-F]{40,64}$/.test(ref))) return false;
    try {
      execFileSync('git', ['-C', assertGitRoot(repoPath), 'merge-base', '--is-ancestor', ancestor, descendant], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }
}

export type IntegrationInput = {
  commitRef: string;
  conflictResolution?: string;
};

export class IntegrationService {
  constructor(
    private readonly store: GoalRepository,
    private readonly inspector: CommitInspector = new GitCommitInspector(),
  ) {}

  prepare(goalId: string, repoPath: string): { commits: string[]; conflicts: string[] } {
    const state = this.store.getGoal(goalId);
    if (!state?.proposal || state.proposal.mode !== 'multi-wp' || state.status !== 'executing')
      throw new UserError('Executing Multi-WP Goal required');
    const packages = Object.values(state.packages ?? {});
    validatePackageGraph(
      state.spec,
      state.proposal,
      packages.map(item => item.spec),
    );
    if (!packages.every(item => item.status === 'green'))
      throw new UserError('All packages must be green before integration');
    const owners = new Map<string, Set<string>>();
    const commits = new Set<string>();
    for (const item of packages) {
      const gate = item.gate;
      if (gate?.result !== 'green' || gate.goalVersion !== state.spec.version)
        throw new UserError(`Stale or missing package gate: ${item.spec.id}`);
      commits.add(gate.deliveryCommit);
      if (!this.inspector.exists(repoPath, gate.deliveryCommit))
        throw new UserError(`Package commit missing: ${gate.deliveryCommit}`);
      for (const file of this.inspector.files(repoPath, gate.deliveryCommit, gate.baseCommit)) {
        if (!owners.has(file)) owners.set(file, new Set());
        owners.get(file)!.add(item.spec.id);
      }
    }
    return {
      commits: [...commits],
      conflicts: [...owners]
        .filter(([, packageIds]) => packageIds.size > 1)
        .map(([file]) => file)
        .sort(),
    };
  }

  complete(goalId: string, repoPath: string, input: IntegrationInput): void {
    const prepared = this.prepare(goalId, repoPath);
    if (prepared.conflicts.length && !input.conflictResolution?.trim())
      throw new Error(`Conflict resolution required: ${prepared.conflicts.join(', ')}`);
    if (!input.commitRef?.trim() || !this.inspector.exists(repoPath, input.commitRef))
      throw new Error('Integration commit missing');
    for (const commit of prepared.commits)
      if (!this.inspector.contains(repoPath, commit, input.commitRef))
        throw new Error(`Package commit not integrated: ${commit}`);
    const state = this.store.getGoal(goalId)!;
    if (state.gate?.deliveryCommit.toLowerCase() !== input.commitRef.toLowerCase() || state.gate.result !== 'green')
      throw new Error('Green controller gate on the integration commit required');
    this.store.append(
      newEvent(goalId, 'integration-completed', {
        commitRef: input.commitRef,
        conflictResolution: input.conflictResolution,
      }),
    );
    new VerificationService(this.store).verify(goalId);
  }
}
