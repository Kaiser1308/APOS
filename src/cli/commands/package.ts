import { PackageService } from '../../app/package-service.js';
import { parseWorkPackage } from '../../domain/packages.js';
import type { CliContext } from '../context.js';

export function registerPackage(ctx: CliContext): void {
  const { program, write, withJournal, readJsonFile } = ctx;
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
    .command('list')
    .argument('<goalId>')
    .action((goalId: string) =>
      withJournal(journal => {
        write(JSON.stringify(journal.getGoal(goalId)?.packages ?? {}));
      }),
    );
}
