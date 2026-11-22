import { GateService } from '../../app/gate-service.js';
import { PackageService } from '../../app/package-service.js';
import { parseWorkPackage } from '../../domain/packages.js';
import type { CliContext } from '../context.js';

export function registerPackage(ctx: CliContext): void {
  const { program, options, write, repo, withJournalAsync, withJournal, readJsonFile } = ctx;
  const packages = program.command('package').description('the Lead plans packages; delivery goes through `submit`');
  packages
    .command('add')
    .requiredOption('--file <json>')
    .requiredOption('--reason <text>')
    .action(({ file, reason }: { file: string; reason: string }) =>
      withJournal(journal => {
        const spec = parseWorkPackage(readJsonFile(file));
        new PackageService(journal).add(spec.goalId, spec, reason);
        write(`Drafted ${spec.id}`);
      }),
    );
  packages
    .command('remove')
    .argument('<goalId>')
    .argument('<packageId>')
    .requiredOption('--reason <text>')
    .action((goalId: string, packageId: string, { reason }: { reason: string }) =>
      withJournal(journal => {
        new PackageService(journal).remove(goalId, packageId, reason);
        write(`Removed ${packageId}`);
      }),
    );
  packages
    .command('revise')
    .argument('<goalId>')
    .requiredOption('--file <json>')
    .requiredOption('--reason <text>')
    .action((goalId: string, { file, reason }: { file: string; reason: string }) =>
      withJournal(journal => {
        const spec = new PackageService(journal).revise(goalId, readJsonFile(file), reason);
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
        const gate = new GateService(journal, { inspector: options.inspector, ...options.gate });
        const service = new PackageService(journal, { gate, repoPath: repo(), inspector: options.inspector });
        const outcome = await service.submit(goalId, packageId, flags.commit, flags.by);
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
