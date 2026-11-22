import { parseWorkPackage, type WorkPackageSpec } from '../domain/packages.js';
import { newEvent } from './events.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { GateResult } from '../domain/gate.js';
import { UserError } from '../domain/errors.js';
import type { GateService } from './gate-service.js';
import { GitCommitInspector } from './integration.js';
import { VerificationService } from './verification.js';

export type SubmitResult = { result: GateResult; reasons: string[]; warnings: string[] };
type Delivery = { gate: GateService; repoPath: string; inspector?: CommitInspector };

/** The Lead's plan edits (which packages a Goal has) and the delivery of a package: `submit`. */
export class PackageService {
  constructor(
    private readonly store: GoalRepository,
    private readonly delivery?: Delivery,
  ) {}

  private record(goalId: string, type: GoalEventType, data: unknown): void {
    this.store.append(newEvent(goalId, type, data));
  }

  add(goalId: string, value: unknown, reason?: string): WorkPackageSpec {
    const spec = parseWorkPackage(value);
    const state = this.store.getGoal(goalId);
    const drafting = state?.status === 'planned' && reason === undefined;
    this.record(goalId, drafting ? 'package-added' : 'package-plan-added', drafting ? spec : { spec, reason });
    return spec;
  }

  remove(goalId: string, packageId: string, reason: string): void {
    this.record(goalId, 'package-removed', { packageId, reason });
  }

  revise(goalId: string, value: unknown, reason: string): WorkPackageSpec {
    const spec = parseWorkPackage(value);
    this.record(goalId, 'package-revised', { spec, reason });
    return spec;
  }

  /**
   * Runs the gate on `commit` right now and records the outcome. The commit is checked first and the gate runs
   * before anything is written, so an invalid commit or an interrupted gate leaves the log as it was. A solo
   * package that goes green also verifies the Goal.
   */
  async submit(goalId: string, packageId: string, commit: string, by: string): Promise<SubmitResult> {
    if (!this.delivery) throw new Error('Submitting a package needs a gate and the repository path');
    const { gate, repoPath } = this.delivery;
    const inspector = this.delivery.inspector ?? new GitCommitInspector();
    const state = this.store.getGoal(goalId);
    if (!state) throw new UserError(`Goal not found: ${goalId}`);
    if (state.status === 'legacy')
      throw new UserError(`${goalId} is a legacy Goal recorded by an older APOS: it is read-only`);
    if (state.status !== 'executing')
      throw new UserError(
        `${goalId} is ${state.status}${state.blocker ? ` (${state.blocker.note})` : ''}: only an executing Goal takes a submission${state.status === 'planned' ? '; run `apos lead commit` first' : ''}`,
      );
    const item = state.packages?.[packageId];
    if (!item) throw new UserError(`Unknown package ${packageId} of ${goalId}`);
    if (!['pending', 'red', 'needs-human', 'submitted'].includes(item.status))
      throw new UserError(
        `${packageId} is ${item.status}: only a pending, red or needs-human package can be submitted`,
      );
    if (!/^[0-9a-fA-F]{40,64}$/.test(commit)) throw new UserError('Submit the full commit sha');
    const base = state.proposal?.baseCommit;
    if (!base) throw new UserError(`${goalId} has no proposal.baseCommit to gate against`);
    if (!inspector.exists(repoPath, commit)) throw new UserError(`Commit ${commit} does not exist in this repository`);
    if (!inspector.contains(repoPath, base, commit))
      throw new UserError(`Commit ${commit} does not contain the base ${base} of ${packageId}`);

    const report = gate.runPackage(goalId, packageId, repoPath, commit, base);
    const submitted = newEvent(goalId, 'package-submitted', {
      packageId,
      version: item.spec.version,
      commit,
      base,
      by,
    });
    this.store.append(submitted);
    this.store.append(
      newEvent(goalId, 'package-gate-recorded', {
        packageId,
        report: { ...report, attemptKey: `${packageId}@${item.spec.version}:${item.attempts}` },
        signature: report.checks
          .filter(check => check.status !== 'pass')
          .map(check => `${check.checkId}[${check.newFailures.join(',')}]`)
          .sort()
          .join('|'),
      }),
    );
    if (report.result === 'green' && state.proposal?.mode !== 'multi-wp')
      new VerificationService(this.store).verify(goalId, commit);
    return {
      result: report.result,
      reasons: report.checks
        .filter(check => check.status !== 'pass')
        .map(check => `${check.checkId} ${check.status}: ${check.reason}`),
      warnings: report.warnings ?? [],
    };
  }
}
