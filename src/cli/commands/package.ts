import { PackageService } from '../../app/package-service.js';
import { parseWorkPackage } from '../../domain/packages.js';
import { assertLeadTerminal } from '../../app/lead.js';
import { newEvent } from '../../app/events.js';
import type { CliContext } from '../context.js';
import { UserError } from '../../domain/errors.js';

export function registerPackage(ctx: CliContext): void {
  const { program, write, packageRuntime, repo, withJournal, withJournalAsync, readJsonFile, assertHuman } = ctx;
  const assertLead = (journal: Parameters<typeof assertHuman>[0], goalId: string, command: string) => {
    const state = journal.getGoal(goalId);
    if (!state) throw new UserError(`Goal not found: ${goalId}`);
    const handle = process.env.ORCA_TERMINAL_HANDLE;
    const foreignTerminal =
      handle &&
      handle !== state.lead?.ref.terminal &&
      journal.listGoals().some(
        goal =>
          goal.lead?.ref.terminal === handle ||
          goal.reviewDispatch?.terminal === handle ||
          Object.values(goal.packages ?? {}).some(item => item.runtimeRef?.terminal === handle) ||
          journal.events(goal.spec.id).some(event => {
            if (
              !['lead-started', 'package-started', 'package-resumed', 'owner-handed-off', 'review-dispatched'].includes(
                event.type,
              )
            )
              return false;
            const data = event.data as { terminal?: string; ref?: { terminal?: string } };
            return (data.ref?.terminal ?? data.terminal) === handle;
          }),
      );
    if (foreignTerminal) throw new UserError(`${command} is Lead only`);
    assertLeadTerminal(state, handle, command);
  };
  const assertLeadOrHuman = (journal: Parameters<typeof assertHuman>[0], goalId: string, command: string) => {
    try {
      assertHuman(journal, command);
    } catch {
      assertLead(journal, goalId, `${command} (Lead or Human only)`);
    }
  };
  const packages = program.command('package');
  packages
    .command('add')
    .requiredOption('--file <json>')
    .requiredOption('--reason <text>')
    .action(({ file, reason }: { file: string; reason: string }) =>
      withJournal(journal => {
        const spec = parseWorkPackage(readJsonFile(file));
        assertLead(journal, spec.goalId, 'package add');
        new PackageService(journal, packageRuntime()).add(spec.goalId, spec, reason);
        write(`Drafted ${spec.id}`);
      }),
    );
  packages
    .command('remove')
    .argument('<goalId>')
    .argument('<packageId>')
    .requiredOption('--reason <text>')
    .action((goalId: string, packageId: string, { reason }: { reason: string }) =>
      withJournalAsync(async journal => {
        assertLead(journal, goalId, 'package remove');
        const item = journal.getGoal(goalId)?.packages?.[packageId];
        if (item?.runtimeRef && !journal.getGoal(goalId)?.settlements?.[item.runtimeRef.dispatchId]) {
          const outcome = await packageRuntime().inspectPackage?.(item.runtimeRef);
          if (outcome !== 'completed' && outcome !== 'failed')
            throw new UserError('Worker must be settled before package removal');
          journal.append(newEvent(goalId, 'worker-settled', { dispatchId: item.runtimeRef.dispatchId, outcome }));
        }
        new PackageService(journal, packageRuntime()).remove(goalId, packageId, reason);
        write(`Removed ${packageId}`);
      }),
    );
  for (const decision of ['approve', 'hold'] as const) {
    packages
      .command(decision)
      .argument('<goalId>')
      .argument('<packageId>')
      .requiredOption('--reason <text>')
      .action((goalId: string, packageId: string, { reason }: { reason: string }) =>
        withJournal(journal => {
          assertLead(journal, goalId, `package ${decision}`);
          const service = new PackageService(journal, packageRuntime());
          if (decision === 'approve') service.approveDispatch(goalId, packageId, reason);
          else service.holdDispatch(goalId, packageId, reason);
          write(`${decision}: ${packageId}`);
        }),
      );
  }
  packages
    .command('approval-policy')
    .argument('<goalId>')
    .argument('<enabled>', 'on or off')
    .requiredOption('--reason <text>')
    .action((goalId: string, enabled: string, { reason }: { reason: string }) =>
      withJournal(journal => {
        assertLead(journal, goalId, 'package approval-policy');
        if (!['on', 'off'].includes(enabled)) throw new UserError('Use on or off');
        new PackageService(journal, packageRuntime()).setApprovalPolicy(goalId, enabled === 'on', reason);
        write(`Approval policy ${enabled}`);
      }),
    );
  packages
    .command('decide-failure')
    .argument('<goalId>')
    .argument('<packageId>')
    .argument('<decision>', 'retry, hold, or escalate')
    .requiredOption('--reason <text>')
    .action((goalId: string, packageId: string, decision: string, { reason }: { reason: string }) =>
      withJournal(journal => {
        assertLead(journal, goalId, 'package decide-failure');
        if (decision !== 'retry' && decision !== 'hold' && decision !== 'escalate')
          throw new UserError('Use retry, hold, or escalate');
        new PackageService(journal, packageRuntime()).decideFailure(goalId, packageId, decision, reason);
        write(`${decision}: ${packageId}`);
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
        assertLead(journal, goalId, 'package revise');
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
