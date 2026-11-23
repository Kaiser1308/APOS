import { withGateLease } from '../../store/lease.js';
import { UserError } from '../../domain/errors.js';
import { blockReason } from '../../domain/review-tests.js';
import { reviewBlockService } from '../test-lock-wiring.js';
import type { CliContext } from '../context.js';

export function registerReview(ctx: CliContext): void {
  const { program, write, withJournal, withJournalAsync } = ctx;
  const review = program
    .command('review')
    .description('a review blocks only with a test that is red when APOS runs it; anything else is advice');

  review
    .command('block')
    .argument('<goalId>')
    .argument('[packageId]', 'the package under review (or use --integration)')
    .requiredOption('--commit <sha>', 'the review commit: one parent, the delivery commit; it only adds test files')
    .requiredOption('--by <reviewer>', 'who reviewed, for the log')
    .option('--integration', 'review the integration commit of a Multi-WP Goal instead of a package')
    .option('--note <text>', 'what the tests show, in words')
    .description(
      'run the tests a review added: red for a reason in the code puts the package back to red; exits 1 then',
    )
    .action(
      (
        goalId: string,
        packageId: string | undefined,
        flags: { commit: string; by: string; integration?: boolean; note?: string },
      ) =>
        withJournalAsync(async journal => {
          if (Boolean(packageId) === Boolean(flags.integration))
            throw new UserError('Name the package to review, or use --integration (not both)');
          const service = reviewBlockService(ctx, journal, goalId);
          const held = await withGateLease(ctx.home(), () =>
            service.block(goalId, packageId, flags.commit, flags.by, flags.note),
          );
          if (!held.ran)
            throw new UserError(
              `Another gate is running for this project (pid ${held.holder}): wait for it, then try again`,
            );
          const result = held.value;
          const scope = packageId ?? `${goalId} integration`;
          if (result.outcome === 'advice') {
            write(
              `Review of ${scope}: the ${result.tests} test(s) added are green on the delivery, so it is advice only and nothing is blocked`,
            );
            return;
          }
          process.exitCode = 1;
          const data = journal.getGoal(goalId)?.reviewTests?.at(-1);
          write(
            `${scope} blocked by review on ${flags.commit}: ${data ? blockReason(data) : result.blocking.join(', ')}`,
          );
          write(`  ${result.tests} test(s) are now locked into the next delivery. Build the fix on ${flags.commit}.`);
        }),
    );

  review
    .command('note')
    .argument('<goalId>')
    .argument('[packageId]')
    .requiredOption('--by <reviewer>')
    .requiredOption('--note <text>')
    .description('record a remark with no test: advice only, it gates nothing')
    .action((goalId: string, packageId: string | undefined, flags: { by: string; note: string }) =>
      withJournal(journal => {
        reviewBlockService(ctx, journal, goalId).note(goalId, packageId, flags.by, flags.note);
        write(`Noted for ${packageId ?? goalId}: advice only`);
      }),
    );
}
