import { newEvent } from './events.js';
import { UserError } from '../domain/errors.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { GoalState } from '../domain/transitions.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import { GitCommitInspector } from './integration.js';
import type { ToolRunner } from './layer-runner.js';
import { inspectTests } from './test-lock-checks.js';

export type TestLockResult = { ok: boolean; problems: string[] };
export type TestLockDeps = {
  repoPath: string;
  runner: ToolRunner;
  /** The setup the Goal is pinned to; throws a UserError when it has none. */
  loadSetup: (state: GoalState) => ProjectSetup;
  inspector?: CommitInspector;
};

/** The tester's side of the Goal: submit the acceptance tests, have them checked, and lock them. */
export class TestLockService {
  private readonly inspector: CommitInspector;
  constructor(
    private readonly store: GoalRepository,
    private readonly deps: TestLockDeps,
  ) {
    this.inspector = deps.inspector ?? new GitCommitInspector();
  }

  /** Same checks, nothing written. Throws a UserError for what is wrong with the request itself. */
  private prepare(goalId: string, commit: string, expect: 'testing' | 'executing') {
    const state = this.store.getGoal(goalId);
    if (!state) throw new UserError(`Goal not found: ${goalId}`);
    if (state.status === 'legacy') throw new UserError(`${goalId} is a legacy Goal: it is read-only`);
    if (state.status !== expect)
      throw new UserError(
        expect === 'testing'
          ? state.testLock
            ? `${goalId} already has locked tests (commit ${state.testLock.commit}): change them with \`apos tests revise\``
            : `${goalId} is ${state.status}: tests are submitted while it is testing, after \`apos lead commit\``
          : `${goalId} is ${state.status}: tests are revised while the Goal is executing`,
      );
    if (!/^[0-9a-fA-F]{40,64}$/.test(commit)) throw new UserError('Submit the full commit sha');
    if (!this.inspector.exists(this.deps.repoPath, commit))
      throw new UserError(`Commit ${commit} does not exist in this repository`);
    const base = state.proposal?.baseCommit;
    if (!base) throw new UserError(`${goalId} has no proposal.baseCommit`);
    return { state, base, setup: this.deps.loadSetup(state) };
  }

  /**
   * Checks `commit` as the Goal's acceptance tests and, only if everything holds, locks them. Reports every problem it
   * finds; a refused commit writes nothing.
   */
  async submit(goalId: string, commit: string, by: string): Promise<TestLockResult> {
    const { state, base, setup } = this.prepare(goalId, commit, 'testing');
    const seen = inspectTests({
      store: this.store,
      repo: this.deps.repoPath,
      state,
      setup,
      commit,
      from: base,
      inspector: this.inspector,
      runner: this.deps.runner,
    });
    if (seen.problems.length) return { ok: false, problems: seen.problems };
    this.store.append(
      newEvent(goalId, 'tests-locked', { commit, files: seen.files, asserts: seen.asserts, map: seen.map, by }),
    );
    return { ok: true, problems: [] };
  }
}
