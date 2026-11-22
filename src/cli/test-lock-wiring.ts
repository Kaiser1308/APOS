import { join } from 'node:path';
import { loadPinnedSetup } from '../app/pinned-setup.js';
import { ToolRunner } from '../app/layer-runner.js';
import { TestLockService } from '../app/test-lock.js';
import { UserError } from '../domain/errors.js';
import { jsonCodec } from '../domain/setup-codec.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';

/** The pinned setup of a Goal, read from the commit it was approved at; undefined when the Goal has none. */
export function pinnedSetupOf(ctx: CliContext, journal: ProjectJournal, setupVersion: number | undefined) {
  return loadPinnedSetup(ctx.repo(), journal.setupHistory(), setupVersion, ctx.options.codec ?? jsonCodec);
}

/** Wires the test-lock service to the repo, the Goal's pinned setup and a runner whose logs stay outside the repo. */
export function testLockService(ctx: CliContext, journal: ProjectJournal, goalId: string): TestLockService {
  const gate = ctx.options.gate;
  const runner = new ToolRunner(ctx.repo(), {
    artifactRoot: join(gate?.artifactRoot ?? journal.artifactRoot(), goalId, 'tests'),
    workspaces: gate?.workspaces,
    executor: gate?.executor,
  });
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
