import { jsonResult } from '../json-result.js';
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
    .option('--json', 'emit JSON')
    .description('check the tests are red for the right reason and lock them; exits 0 locked, 1 refused')
    .action((goalId: string, flags: { commit: string; by: string; json?: boolean }) =>
      withJournalAsync(async journal => {
        const service = testLockService(ctx, journal, goalId);
        const held = await withGateLease(ctx.home(), () => service.submit(goalId, flags.commit, flags.by));
        if (!held.ran)
          throw new UserError(
            `Another gate is running for this project (pid ${held.holder}): wait for it, then submit again`,
          );
        if (flags.json) {
          const verdict = held.value.ok ? 'green' : 'red';
          process.exitCode = held.value.ok ? 0 : 1;
          write(
            JSON.stringify({
              ...jsonResult('tests submit', journal.getGoal(goalId), verdict),
              deliveryCommit: flags.commit,
              problems: held.value.ok ? [] : held.value.problems,
            }),
          );
          return;
        }
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
    .command('revise')
    .argument('<goalId>')
    .requiredOption(
      '--commit <sha>',
      'the full sha of a commit that contains the locked one and changes tests, stubs or tests.json',
    )
    .requiredOption('--reason <text>', 'why the locked tests change (the public entry changed, ...)')
    .option('--by <name>', 'who revises, for the log', 'tester')
    .description('replace the lock; exits 0 locked, 1 refused, 3 weaker than the lock and waiting for an exception')
    .action((goalId: string, flags: { commit: string; reason: string; by: string }) =>
      withJournalAsync(async journal => {
        const service = testLockService(ctx, journal, goalId);
        const held = await withGateLease(ctx.home(), () =>
          service.revise(goalId, flags.commit, flags.reason, flags.by),
        );
        if (!held.ran)
          throw new UserError(
            `Another gate is running for this project (pid ${held.holder}): wait for it, then try again`,
          );
        const outcome = held.value;
        if (outcome.pending) {
          process.exitCode = 3;
          write(`tests revision ${flags.commit} is weaker than the lock and waits for approval:`);
          for (const problem of outcome.problems) write(`  ${problem}`);
          write(
            `Approve with: apos exception approve ${goalId} --kind tests-weakened --ref ${flags.commit} --reason <why> (--by agent:<name> | --human), then run this command again.`,
          );
          return;
        }
        if (!outcome.ok) {
          process.exitCode = 1;
          write(`tests revision refused on ${flags.commit}: nothing changed`);
          for (const problem of outcome.problems) write(`  ${problem}`);
          return;
        }
        write(
          `Tests locked on ${flags.commit} (revision). Every package is gated again: rebase each onto it and submit.`,
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
