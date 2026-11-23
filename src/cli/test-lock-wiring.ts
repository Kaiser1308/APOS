import { join } from 'node:path';
import { loadPinnedSetup } from '../app/pinned-setup.js';
import { AssuranceService } from '../app/assurance-service.js';
import { GitCommitInspector } from '../app/integration.js';
import { ToolRunner } from '../app/layer-runner.js';
import { ReviewBlockService } from '../app/review-block.js';
import { TestLockService } from '../app/test-lock.js';
import { UserError } from '../domain/errors.js';
import { yamlCodec } from '../domain/setup-codec.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';

/** The pinned setup of a Goal, read from the commit it was approved at; undefined when the Goal has none. */
export function pinnedSetupOf(ctx: CliContext, journal: ProjectJournal, setupVersion: number | undefined) {
  return loadPinnedSetup(ctx.repo(), journal.setupHistory(), setupVersion, ctx.options.codec ?? yamlCodec);
}

/** A tool runner whose logs stay outside the repo, for a Goal. */
export const runnerFor = (ctx: CliContext, journal: ProjectJournal, goalId: string, dir: string) => {
  const gate = ctx.options.gate;
  return new ToolRunner(ctx.repo(), {
    artifactRoot: join(gate?.artifactRoot ?? journal.artifactRoot(), goalId, dir),
    workspaces: gate?.workspaces,
    executor: gate?.executor,
  });
};

/** The locked-tests, inventory and scope checks of a package gate, wired to the Goal's pinned setup. */
export function assuranceService(ctx: CliContext, journal: ProjectJournal, goalId: string): AssuranceService {
  return new AssuranceService({
    repo: ctx.repo(),
    runner: runnerFor(ctx, journal, goalId, 'gate-runs'),
    inspector: ctx.options.inspector ?? new GitCommitInspector(),
    loadSetup: state => pinnedSetupOf(ctx, journal, state.setupVersion),
    goals: () => journal.listGoals(),
  });
}

/** Wires the test-lock service to the repo, the Goal's pinned setup and a runner whose logs stay outside the repo. */
export function testLockService(ctx: CliContext, journal: ProjectJournal, goalId: string): TestLockService {
  const runner = runnerFor(ctx, journal, goalId, 'tests');
  return new TestLockService(journal, {
    repoPath: ctx.repo(),
    runner,
    inspector: ctx.options.inspector,
    loadSetup: state => {
      const setup = pinnedSetupOf(ctx, journal, state.setupVersion);
      if (!setup) throw new UserError(`${goalId} is not pinned to a setup: there are no tests to lock`);
      return setup;
    },
  });
}

/** Wires the review service to the repo, the Goal's pinned setup and a runner whose logs stay outside the repo. */
export function reviewBlockService(ctx: CliContext, journal: ProjectJournal, goalId: string): ReviewBlockService {
  return new ReviewBlockService(journal, {
    repoPath: ctx.repo(),
    runner: runnerFor(ctx, journal, goalId, 'review'),
    inspector: ctx.options.inspector,
    loadSetup: state => {
      const setup = pinnedSetupOf(ctx, journal, state.setupVersion);
      if (!setup) throw new UserError(`${goalId} is not pinned to a setup: a review cannot run its tests`);
      return setup;
    },
  });
}
