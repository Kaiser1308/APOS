import { UserError } from '../../domain/errors.js';
import { withGateLease } from '../../store/lease.js';
import { GateService } from '../../app/gate-service.js';
import { PackageService } from '../../app/package-service.js';
import { parseWorkPackage } from '../../domain/packages.js';
import { assuranceService } from '../test-lock-wiring.js';
import type { CliContext } from '../context.js';

export function registerPackage(ctx: CliContext): void {
  const { program, options, write, repo, withJournalAsync, withJournal, readJsonFile } = ctx;
  const packages = program.command('package').description('the Lead plans packages; delivery goes through `submit`');
  packages
    .command('add')
    .requiredOption('--file <json>')
    .requiredOption('--reason <text>')
    .option('--by <name>', 'who plans, for the log', 'lead')
    .action(({ file, reason, by }: { file: string; reason: string; by: string }) =>
      withJournal(journal => {
        const spec = parseWorkPackage(readJsonFile(file));
        new PackageService(journal).add(spec.goalId, spec, reason, by);
        write(`Drafted ${spec.id}`);
      }),
    );
  packages
    .command('remove')
    .argument('<goalId>')
    .argument('<packageId>')
    .requiredOption('--reason <text>')
    .option('--by <name>', 'who plans, for the log', 'lead')
    .action((goalId: string, packageId: string, { reason, by }: { reason: string; by: string }) =>
      withJournal(journal => {
        new PackageService(journal).remove(goalId, packageId, reason, by);
        write(`Removed ${packageId}`);
      }),
    );
  packages
    .command('revise')
    .argument('<goalId>')
    .requiredOption('--file <json>')
    .requiredOption('--reason <text>')
    .option('--by <name>', 'who plans, for the log', 'lead')
    .action((goalId: string, { file, reason, by }: { file: string; reason: string; by: string }) =>
      withJournal(journal => {
        const spec = new PackageService(journal).revise(goalId, readJsonFile(file), reason, by);
        write(`Revised ${spec.id} v${spec.version}`);
      }),
    );
  packages
    .command('submit')
    .argument('<goalId>')
    .argument('<packageId>', 'WP-MAIN for a Solo plan')
    .requiredOption('--commit <sha>', 'the full sha of the commit to gate')
    .option('--by <name>', 'who submits, for the log', 'lead')
    .option('--json', 'print the result as JSON')
    .description('Lead: gate this commit now; exits 0 green, 1 red, 3 needs a Human or could not be verified')
    .action((goalId: string, packageId: string, flags: { commit: string; by: string; json?: boolean }) =>
      withJournalAsync(async journal => {
        const gate = new GateService(journal, {
          inspector: options.inspector,
          ...options.gate,
          assurance: assuranceService(ctx, journal, goalId),
        });
        const service = new PackageService(journal, { gate, repoPath: repo(), inspector: options.inspector });
        const held = await withGateLease(ctx.home(), () => service.submit(goalId, packageId, flags.commit, flags.by));
        if (!held.ran)
          throw new UserError(
            `Another gate is running for this project (pid ${held.holder}): wait for it, then submit again`,
          );
        const outcome = held.value;
        const state = journal.getGoal(goalId);
        process.exitCode = outcome.result === 'green' ? 0 : outcome.result === 'red' ? 1 : 3;
        if (flags.json) {
          write(JSON.stringify({ goalId, packageId, commit: flags.commit, ...outcome, goalStatus: state?.status }));
          return;
        }
        write(
          `${packageId} ${outcome.result} on ${flags.commit}${outcome.result === 'green' && state?.status === 'verified' ? `; ${goalId} verified` : ''}`,
        );
        for (const reason of outcome.reasons) write(`  ${reason}`);
        for (const warning of outcome.warnings) write(`  ${warning}`);
        if (state?.status === 'blocked') write(`${goalId} is blocked: ${state.blocker?.note}`);
      }),
    );
  packages
    .command('list')
    .argument('<goalId>')
    .action((goalId: string) =>
      withJournal(journal => {
        write(JSON.stringify(journal.getGoal(goalId)?.packages ?? {}));
      }),
    );
}
