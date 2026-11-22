import { withGateLease } from '../../store/lease.js';
import { UserError } from '../../domain/errors.js';
import { lockedTestKeys } from '../../domain/test-lock.js';
import { lockSummary } from '../lock-summary.js';
import { testLockService } from '../test-lock-wiring.js';
import type { CliContext } from '../context.js';

export function registerTests(ctx: CliContext): void {
  const { program, write, withJournal, withJournalAsync } = ctx;
  const tests = program.command('tests').description('the tester submits acceptance tests; APOS checks and locks them');

  tests
    .command('submit')
    .argument('<goalId>')
    .requiredOption('--commit <sha>', 'the full sha of the commit holding the tests, the stubs and tests.json')
    .option('--by <name>', 'who submits, for the log', 'tester')
    .description('check the tests are red for the right reason and lock them; exits 0 locked, 1 refused')
    .action((goalId: string, flags: { commit: string; by: string }) =>
      withJournalAsync(async journal => {
        const service = testLockService(ctx, journal, goalId);
        const held = await withGateLease(ctx.home(), () => service.submit(goalId, flags.commit, flags.by));
        if (!held.ran)
          throw new UserError(
            `Another gate is running for this project (pid ${held.holder}): wait for it, then submit again`,
          );
        if (!held.value.ok) {
          process.exitCode = 1;
          write(`tests refused on ${flags.commit}: nothing is locked`);
          for (const problem of held.value.problems) write(`  ${problem}`);
          return;
        }
        const lock = journal.getGoal(goalId)?.testLock;
        write(
          `Locked ${lock ? lockedTestKeys(lock).length : 0} tests in ${Object.keys(lock?.files ?? {}).length} files on ${flags.commit}. Packages are gated on top of this commit.`,
        );
      }),
    );

  tests
    .command('show')
    .argument('<goalId>')
    .description('the locked commit, tests per layer, and which tests prove which criterion')
    .action((goalId: string) =>
      withJournal(journal => {
        const state = journal.getGoal(goalId);
        if (!state) throw new UserError(`Goal not found: ${goalId}`);
        const lock = state.testLock;
        for (const line of lockSummary(state)) write(`${goalId}: ${line}`);
        if (!lock) return;
        const perLayer = new Map<string, number>();
        for (const entry of lock.map)
          perLayer.set(
            `${entry.part}.${entry.layer}`,
            (perLayer.get(`${entry.part}.${entry.layer}`) ?? 0) + entry.testIds.length,
          );
        for (const [layer, count] of perLayer) write(`  ${layer}: ${count} tests`);
        for (const entry of lock.map)
          write(`  ${entry.acceptanceId} -> ${entry.part}.${entry.layer}: ${entry.testIds.join(', ')}`);
      }),
    );
}
