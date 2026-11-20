import { PackageService } from '../../app/package-service.js';
import { parseWorkPackage } from '../../domain/packages.js';
import { assertLeadTerminal } from '../../app/lead.js';
import type { CliContext } from '../context.js';

export function registerPackage(ctx: CliContext): void {
  const { program, write, packageRuntime, repo, withJournal, withJournalAsync, readJsonFile, assertHuman } = ctx;
  const assertLeadOrHuman = (journal: Parameters<typeof assertHuman>[0], goalId: string, command: string) => {
    try {
      assertHuman(journal, command);
    } catch {
      const handle = process.env.ORCA_TERMINAL_HANDLE;
      const workerTerminal = journal
        .listGoals()
        .some(goal =>
          Object.values(goal.packages ?? {}).some(item => item.runtimeRef?.terminal === handle && Boolean(handle)),
        );
      if (workerTerminal) throw new Error(`${command}: Lead or Human only`);
      const state = journal.getGoal(goalId);
      if (!state) throw new Error(`${command}: Goal not found`);
      assertLeadTerminal(state, process.env.ORCA_TERMINAL_HANDLE, `${command} (Lead or Human only)`);
    }
  };
  const packages = program.command('package');
  packages
    .command('add')
    .requiredOption('--file <json>')
    .action(({ file }: { file: string }) =>
      withJournal(journal => {
        const spec = parseWorkPackage(readJsonFile(file));
        new PackageService(journal, packageRuntime()).add(spec.goalId, spec);
        write(`Drafted ${spec.id}`);
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
  packages
    .command('ready')
    .argument('<goalId>')
    .action((goalId: string) =>
      withJournal(journal => {
        write(JSON.stringify(new PackageService(journal, packageRuntime()).ready(goalId).map(item => item.id)));
      }),
    );
  packages
    .command('dispatch')
    .argument('<goalId>')
    .action((goalId: string) =>
      withJournalAsync(async journal => {
        const refs = await new PackageService(journal, packageRuntime()).dispatchReady(goalId, repo());
        write(JSON.stringify(refs));
      }),
    );
  packages
    .command('reconcile')
    .argument('<goalId>')
    .action((goalId: string) =>
      withJournalAsync(async journal => {
        write(JSON.stringify(await new PackageService(journal, packageRuntime()).reconcile(goalId)));
      }),
    );
  packages
    .command('evidence')
    .argument('<goalId>')
    .requiredOption('--file <json>')
    .action((goalId: string, { file }: { file: string }) =>
      withJournal(journal => {
        assertLeadOrHuman(journal, goalId, 'package evidence');
        const evidence = new PackageService(journal, packageRuntime()).submitEvidence(goalId, readJsonFile(file));
        write(`Recorded ${evidence.packageId} ${evidence.acceptanceId}`);
      }),
    );
  packages
    .command('verify')
    .argument('<goalId>')
    .argument('<packageId>')
    .action((goalId: string, packageId: string) =>
      withJournalAsync(async journal => {
        assertLeadOrHuman(journal, goalId, 'package verify');
        const service = new PackageService(journal, packageRuntime());
        await service.verify(goalId, packageId);
        const refs = await service.dispatchReady(goalId, repo());
        write(`Verified ${packageId}; dispatched ${refs.map(ref => ref.dispatchId).join(', ') || 'none'}`);
      }),
    );
  packages
    .command('revise')
    .argument('<goalId>')
    .requiredOption('--file <json>')
    .requiredOption('--reason <text>')
    .action((goalId: string, { file, reason }: { file: string; reason: string }) =>
      withJournal(journal => {
        const spec = new PackageService(journal, packageRuntime()).revise(goalId, readJsonFile(file), reason);
        write(`Revised ${spec.id} v${spec.version}`);
      }),
    );
  packages
    .command('block')
    .argument('<goalId>')
    .argument('<packageId>')
    .requiredOption('--kind <kind>')
    .requiredOption('--note <text>')
    .action(
      (
        goalId: string,
        packageId: string,
        { kind, note }: { kind: 'technical' | 'product' | 'external'; note: string },
      ) =>
        withJournal(journal => {
          new PackageService(journal, packageRuntime()).recordBlocker(goalId, packageId, kind, note);
          write(`Blocked ${packageId}`);
        }),
    );
  packages
    .command('unblock')
    .argument('<goalId>')
    .argument('<packageId>')
    .requiredOption('--resolution <text>')
    .action((goalId: string, packageId: string, { resolution }: { resolution: string }) =>
      withJournal(journal => {
        new PackageService(journal, packageRuntime()).unblock(goalId, packageId, resolution);
        write(`Unblocked ${packageId}`);
      }),
    );
  packages
    .command('resume')
    .argument('<goalId>')
    .argument('<packageId>')
    .action((goalId: string, packageId: string) =>
      withJournalAsync(async journal => {
        const ref = await new PackageService(journal, packageRuntime()).resumeStale(goalId, packageId);
        write(`Resumed ${packageId}: ${ref.dispatchId}`);
      }),
    );
}
