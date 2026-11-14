import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validatePackageGraph } from '../domain/packages.js';
import type { Evidence } from '../domain/contracts.js';
import type { GoalRepository } from '../store/journal.js';
import { assertGitRoot } from '../store/project-history.js';
import { VerificationService } from './verification.js';
import { requiresIndependentReview } from '../domain/reviews.js';
import type { PackageRuntimeRef } from './packages.js';

export interface CommitInspector {
  exists(repoPath: string, ref: string): boolean;
  files(repoPath: string, ref: string, baseCommit?: string): string[];
  contains(repoPath: string, ancestor: string, descendant: string): boolean;
}

export class GitCommitInspector implements CommitInspector {
  exists(repoPath: string, ref: string): boolean {
    if (!/^[0-9a-fA-F]{40,64}$/.test(ref)) return false;
    try { execFileSync('git', ['-C', assertGitRoot(repoPath), 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' }); return true; }
    catch { return false; }
  }
  files(repoPath: string, ref: string, baseCommit?: string): string[] {
    if (!/^[0-9a-fA-F]{40,64}$/.test(ref)) throw new Error('Full commit hash required');
    if (baseCommit) {
      if (!/^[0-9a-fA-F]{40,64}$/.test(baseCommit)) throw new Error('Full package base commit required');
      return execFileSync('git', ['-C', assertGitRoot(repoPath), 'diff', '--name-only', baseCommit, ref], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    }
    return execFileSync('git', ['-C', assertGitRoot(repoPath), 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', ref], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  }
  contains(repoPath: string, ancestor: string, descendant: string): boolean {
    if (![ancestor, descendant].every(ref => /^[0-9a-fA-F]{40,64}$/.test(ref))) return false;
    try { execFileSync('git', ['-C', assertGitRoot(repoPath), 'merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' }); return true; }
    catch { return false; }
  }
}

export type IntegrationInput = {
  commitRef: string;
  acceptance: Evidence[];
  regression: { result: 'pass' | 'fail'; command: string; artifactRef: string };
  conflictResolution?: string;
};

export class IntegrationService {
  constructor(private readonly store: GoalRepository, private readonly inspector: CommitInspector = new GitCommitInspector()) {}

  prepare(goalId: string, repoPath: string): { commits: string[]; conflicts: string[] } {
    const state = this.store.getGoal(goalId);
    if (!state?.proposal || state.proposal.mode !== 'multi-wp' || state.status !== 'executing') throw new Error('Executing Multi-WP Goal required');
    const packages = Object.values(state.packages ?? {});
    validatePackageGraph(state.spec, state.proposal, packages.map(item => item.spec));
    if (!packages.every(item => item.status === 'verified')) throw new Error('All packages must be verified before integration');
    const owners = new Map<string, Set<string>>();
    const commits = new Set<string>();
    for (const item of packages) {
      const latest = new Map(item.evidence.map(evidence => [evidence.acceptanceId, evidence]));
      for (const criterion of item.spec.acceptance) {
        const evidence = latest.get(criterion.id);
        if (!evidence || evidence.result !== 'pass' || evidence.packageVersion !== item.spec.version || evidence.owner !== item.spec.owner) throw new Error(`Stale or missing package evidence: ${item.spec.id}`);
        commits.add(evidence.commitRef);
        if (!this.inspector.exists(repoPath, evidence.commitRef)) throw new Error(`Package commit missing: ${evidence.commitRef}`);
        for (const file of this.inspector.files(repoPath, evidence.commitRef, (item.runtimeRef as PackageRuntimeRef | undefined)?.baseCommit)) {
          if (!owners.has(file)) owners.set(file, new Set());
          owners.get(file)!.add(item.spec.id);
        }
      }
    }
    return { commits: [...commits], conflicts: [...owners].filter(([, packageIds]) => packageIds.size > 1).map(([file]) => file).sort() };
  }

  complete(goalId: string, repoPath: string, input: IntegrationInput): void {
    const prepared = this.prepare(goalId, repoPath);
    if (prepared.conflicts.length && !input.conflictResolution?.trim()) throw new Error(`Conflict resolution required: ${prepared.conflicts.join(', ')}`);
    if (!input.commitRef?.trim() || !this.inspector.exists(repoPath, input.commitRef)) throw new Error('Integration commit missing');
    for (const commit of prepared.commits) if (!this.inspector.contains(repoPath, commit, input.commitRef)) throw new Error(`Package commit not integrated: ${commit}`);
    if (input.regression?.result !== 'pass' || !input.regression.command?.trim() || !input.regression.artifactRef?.trim()) throw new Error('Passing regression evidence required');
    const state = this.store.getGoal(goalId)!;
    if (state.gate?.deliveryCommit.toLowerCase() !== input.commitRef.toLowerCase() || state.gate.result !== 'green') throw new Error('Green controller gate on the integration commit required');
    if (requiresIndependentReview(state)) {
      const review = [...state.reviews].reverse().find(item => item.subject === 'goal');
      if (review?.result !== 'pass' || review.commitRef !== input.commitRef) throw new Error('Passing independent Goal review of integration commit required: the controller dispatches the reviewer once the integration gate is green and wakes the Lead with the verdict; run integration complete again after a pass');
    }
    const latest = new Map(input.acceptance.map(item => [item.acceptanceId, item]));
    if (!state.spec.acceptance.every(item => latest.get(item.id)?.result === 'pass' && latest.get(item.id)?.command?.trim() && latest.get(item.id)?.artifactRef?.trim())) throw new Error('Passing Goal acceptance evidence required');
    this.store.append({ id: randomUUID(), goalId, type: 'integration-completed', data: { commitRef: input.commitRef, conflictResolution: input.conflictResolution, regression: input.regression }, at: new Date().toISOString() });
    const verification = new VerificationService(this.store);
    for (const item of input.acceptance) verification.submitEvidence(goalId, item);
    verification.verify(goalId);
  }
}

export const INTEGRATION_EXAMPLE = '{"commitRef":"<integration commit sha>","acceptance":[{"acceptanceId":"AC-1","result":"pass","command":"npm test","artifactRef":"log:acceptance"}],"regression":{"result":"pass","command":"npm test","artifactRef":"log:regression"}}';

/** Validates the `integration complete --file` input, naming every missing or invalid field at once rather than one per run. */
export function parseIntegrationInput(raw: unknown): IntegrationInput {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  const problems: string[] = [];
  if (!text(input.commitRef)) problems.push('commitRef');
  if (!Array.isArray(input.acceptance) || !input.acceptance.length) problems.push('acceptance (a non-empty list)');
  else input.acceptance.forEach((item: Record<string, unknown>, index) => {
    if (!text(item?.acceptanceId)) problems.push(`acceptance[${index}].acceptanceId`);
    if (item?.result !== 'pass' && item?.result !== 'fail') problems.push(`acceptance[${index}].result`);
    if (!text(item?.command)) problems.push(`acceptance[${index}].command`);
    if (!text(item?.artifactRef)) problems.push(`acceptance[${index}].artifactRef`);
  });
  const regression = (input.regression && typeof input.regression === 'object' ? input.regression : {}) as Record<string, unknown>;
  if (regression.result !== 'pass' && regression.result !== 'fail') problems.push('regression.result');
  if (!text(regression.command)) problems.push('regression.command');
  if (!text(regression.artifactRef)) problems.push('regression.artifactRef');
  if (problems.length) throw new Error(`Integration input is missing or invalid: ${problems.join(', ')}. Minimal file: ${INTEGRATION_EXAMPLE}`);
  return input as IntegrationInput;
}
