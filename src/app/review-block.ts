import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newEvent } from './events.js';
import { fileAt, sha256Of } from './git-files.js';
import { GitCommitInspector } from './integration.js';
import type { ToolRunner } from './layer-runner.js';
import { UserError } from '../domain/errors.js';
import type { LayerId } from '../domain/layers.js';
import { matchesAny, rootedGlobs } from '../domain/glob.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { TestOutcome } from '../domain/results/index.js';
import { testRefKey, type ReviewTestLock } from '../domain/review-tests.js';
import type { GoalState } from '../domain/transitions.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import { assertGitRoot } from '../store/project-history.js';

const REVIEW_LAYERS: readonly LayerId[] = ['L1', 'L2', 'L3'];
type Ref = { part: string; layer: LayerId; id: string };

export type ReviewBlockDeps = {
  repoPath: string;
  runner: ToolRunner;
  /** The setup the Goal is pinned to; throws a UserError when it has none. */
  loadSetup: (state: GoalState) => ProjectSetup;
  inspector?: CommitInspector;
};

export type BlockResult = {
  /** `blocked`: the package is red; `advice`: every new test is green on the delivery, so nothing is blocked. */
  outcome: 'blocked' | 'advice';
  tests: number;
  blocking: string[];
  alsoRedBefore: string[];
};

const git = (repo: string, args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', ['-C', assertGitRoot(repo), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  }).trim();

/** `base` with the given files of `from` laid over it, as a commit object nobody points at: where the reviewer's tests meet the code from before the Goal. */
function overlayCommit(repo: string, base: string, from: string, files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'apos-overlay-'));
  const env = {
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: 'apos',
    GIT_AUTHOR_EMAIL: 'apos@local.invalid',
    GIT_COMMITTER_NAME: 'apos',
    GIT_COMMITTER_EMAIL: 'apos@local.invalid',
  };
  try {
    git(repo, ['read-tree', base], env);
    for (const file of files)
      git(
        repo,
        ['update-index', '--add', '--cacheinfo', `100644,${git(repo, ['rev-parse', `${from}:${file}`])},${file}`],
        env,
      );
    return git(
      repo,
      ['commit-tree', git(repo, ['write-tree'], env), '-p', base, '-m', 'apos: review tests over the plan base'],
      env,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

const matchesLoadError = (test: TestOutcome, patterns: string[]) =>
  patterns.some(pattern => new RegExp(pattern, 'm').test(test.message ?? ''));

/**
 * A review blocks only with a test. The reviewer commits tests on top of the delivery; APOS runs the new ones, and a
 * red test (red for a reason in the code, not because it could not load) puts the package back to red and is locked
 * into its next delivery. Green tests and plain remarks are advice. Nothing a model or a person says counts without it.
 */
export class ReviewBlockService {
  private readonly inspector: CommitInspector;
  constructor(
    private readonly store: GoalRepository,
    private readonly deps: ReviewBlockDeps,
  ) {
    this.inspector = deps.inspector ?? new GitCommitInspector();
  }

  /** The commit a review of `packageId` (or of the integration, when undefined) is about, after the checks every review shares. */
  private target(goalId: string, packageId: string | undefined, reviewCommit: string) {
    const { repoPath } = this.deps;
    const state = this.store.getGoal(goalId);
    if (!state) throw new UserError(`Goal not found: ${goalId}`);
    if (state.status === 'legacy') throw new UserError(`${goalId} is a legacy Goal: it is read-only`);
    if (state.status !== 'executing' && state.status !== 'verified')
      throw new UserError(
        `${goalId} is ${state.status}: a review blocks the delivery of an executing or verified Goal`,
      );
    let delivery: string | undefined;
    if (packageId) {
      const item = state.packages?.[packageId];
      if (!item) throw new UserError(`Unknown package ${packageId} of ${goalId}`);
      delivery = item.gate?.deliveryCommit;
      if (!delivery) throw new UserError(`${packageId} has no gated delivery yet: there is nothing to review`);
    } else {
      delivery = state.integration?.commitRef;
      if (!delivery)
        throw new UserError(`${goalId} has no integration commit: review a package, or integrate the packages first`);
    }
    if (!/^[0-9a-fA-F]{40,64}$/.test(reviewCommit)) throw new UserError('Give the full commit sha');
    if (!this.inspector.exists(repoPath, reviewCommit))
      throw new UserError(`Commit ${reviewCommit} does not exist in this repository`);
    return { state, delivery };
  }

  /** The files a review commit adds, refused unless the commit has the delivery as its one parent and adds test files only. */
  private addedTests(delivery: string, reviewCommit: string, setup: ProjectSetup) {
    const { repoPath } = this.deps;
    const parents = git(repoPath, ['rev-list', '--parents', '-n', '1', reviewCommit]).split(/\s+/).slice(1);
    if (parents.length !== 1 || parents[0]!.toLowerCase() !== delivery.toLowerCase())
      throw new UserError(
        `the review commit must have exactly one parent, the delivery commit ${delivery} (it has ${parents.length ? parents.join(', ') : 'none'})`,
      );
    const changes = git(repoPath, ['diff', '--name-status', '--no-renames', '-z', delivery, reviewCommit])
      .split('\0')
      .filter(Boolean);
    const problems: string[] = [];
    const files: string[] = [];
    for (let i = 0; i + 1 < changes.length; i += 2) {
      const [status, file] = [changes[i]!, changes[i + 1]!];
      const isTest = Object.values(setup.parts).some(
        part => part.tests && matchesAny(file, rootedGlobs(part.root, part.tests.paths)),
      );
      if (file.startsWith('.apos/') || !isTest)
        problems.push(
          `${file} is not a test file of the setup (parts.<name>.tests.paths): a review may only add tests`,
        );
      else if (status !== 'A')
        problems.push(
          `${file} is ${status === 'D' ? 'deleted' : 'modified'}: a review may only add tests, never change one that exists`,
        );
      else files.push(file);
    }
    if (problems.length) throw new UserError(`the review commit is refused:\n  ${problems.join('\n  ')}`);
    if (!files.length) throw new UserError('the review commit adds no file');
    return files;
  }

  /** Every test of the layers the new files can live in, at `commit`, with the problems of those runs. */
  private run(commit: string, setup: ProjectSetup, files: string[]) {
    const tests = new Map<string, { ref: Ref; outcome: TestOutcome; patterns: string[] }>();
    const problems: string[] = [];
    for (const [part, where] of Object.entries(setup.parts)) {
      if (!where.tests || !files.some(file => matchesAny(file, rootedGlobs(where.root, where.tests!.paths)))) continue;
      for (const layer of REVIEW_LAYERS) {
        const tools = where.layers[layer] ?? [];
        if (!tools.length) continue;
        const result = this.deps.runner.layerTests(commit, part, where.root, layer, tools);
        problems.push(...result.problems);
        for (const outcome of result.tests)
          tests.set(`${part}.${layer}::${outcome.id}`, {
            ref: { part, layer, id: outcome.id },
            outcome,
            patterns: where.tests.loadErrorPatterns,
          });
      }
    }
    return { tests, problems };
  }

  async block(
    goalId: string,
    packageId: string | undefined,
    reviewCommit: string,
    by: string,
    note?: string,
  ): Promise<BlockResult> {
    const { repoPath } = this.deps;
    const { state, delivery } = this.target(goalId, packageId, reviewCommit);
    const setup = this.deps.loadSetup(state);
    const files = this.addedTests(delivery, reviewCommit, setup);
    const before = this.run(delivery, setup, files);
    const after = this.run(reviewCommit, setup, files);
    const problems = [...before.problems, ...after.problems];
    if (problems.length)
      throw new UserError(`the layers did not run, so the tests cannot be judged:\n  ${problems.join('\n  ')}`);
    const added = [...after.tests].filter(([key]) => !before.tests.has(key));
    const unloaded = added.filter(
      ([, item]) => ['fail', 'error'].includes(item.outcome.status) && matchesLoadError(item.outcome, item.patterns),
    );
    if (unloaded.length)
      throw new UserError(
        `the review tests did not load, so they prove nothing: ${unloaded.map(([, item]) => `${item.ref.id}: ${(item.outcome.message ?? item.outcome.status).split(/\r?\n/)[0]}`).join('; ')}`,
      );
    if (!added.length)
      throw new UserError('the review commit adds no test that the layers of the setup run (L1, L2 or L3)');
    const red = added.filter(([, item]) => item.outcome.status === 'fail' || item.outcome.status === 'error');
    const tests = added.map(([, item]) => item.ref);
    if (!red.length) {
      this.advice(
        state,
        packageId,
        delivery,
        reviewCommit,
        by,
        `the ${tests.length} test(s) added at ${reviewCommit} are green on the delivery: nothing is blocked${note ? `. ${note}` : ''}`,
      );
      return { outcome: 'advice', tests: tests.length, blocking: [], alsoRedBefore: [] };
    }
    const blocking = red.map(([, item]) => item.ref);
    const alsoRedBefore = this.redBeforeTheGoal(state, setup, reviewCommit, files, blocking);
    const data: ReviewTestLock = {
      ...(packageId ? { packageId } : {}),
      deliveryCommit: delivery,
      reviewCommit,
      files: Object.fromEntries(
        files.map(file => [file, sha256Of(fileAt(repoPath, reviewCommit, file) ?? Buffer.alloc(0))]),
      ),
      tests,
      blocking,
      alsoRedBefore,
      by,
      ...(note ? { note } : {}),
    };
    this.store.append(newEvent(goalId, 'review-blocked', data));
    return {
      outcome: 'blocked',
      tests: tests.length,
      blocking: blocking.map(item => item.id),
      alsoRedBefore: alsoRedBefore.map(item => item.id),
    };
  }

  /** Information only: of the blocking tests, the ones that do not pass on the plan's base commit either. Never stops a block. */
  private redBeforeTheGoal(
    state: GoalState,
    setup: ProjectSetup,
    reviewCommit: string,
    files: string[],
    blocking: Ref[],
  ): Ref[] {
    const base = state.proposal?.baseCommit;
    if (!base) return [];
    try {
      const over = this.run(overlayCommit(this.deps.repoPath, base, reviewCommit, files), setup, files);
      if (over.problems.length) return [];
      // A test that is not in the report at all did not load there (the code it calls did not exist yet): it does not pass either.
      return blocking.filter(ref => over.tests.get(testRefKey(ref))?.outcome.status !== 'pass');
    } catch {
      return [];
    }
  }

  private advice(
    state: GoalState,
    packageId: string | undefined,
    delivery: string,
    commit: string,
    by: string,
    note: string,
  ) {
    const item = packageId ? state.packages?.[packageId] : undefined;
    this.store.append(
      newEvent(state.spec.id, 'review-submitted', {
        subject: item ? 'package' : 'goal',
        ...(item ? { packageId, packageVersion: item.spec.version } : {}),
        reviewer: by,
        session: by,
        result: 'pass',
        commitRef: commit,
        note: `${note} (delivery ${delivery})`,
      }),
    );
  }

  /** A remark with no test: advice, it gates nothing. */
  note(goalId: string, packageId: string | undefined, by: string, note: string): void {
    const state = this.store.getGoal(goalId);
    if (!state) throw new UserError(`Goal not found: ${goalId}`);
    if (state.status === 'legacy') throw new UserError(`${goalId} is a legacy Goal: it is read-only`);
    const item = packageId ? state.packages?.[packageId] : undefined;
    if (packageId && !item) throw new UserError(`Unknown package ${packageId} of ${goalId}`);
    const commit = item?.gate?.deliveryCommit ?? state.integration?.commitRef ?? state.proposal?.baseCommit;
    if (!commit) throw new UserError(`${goalId} has no commit to attach the note to yet`);
    this.advice(state, packageId, commit, commit, by, `advice only, no test: ${note}`);
  }
}
