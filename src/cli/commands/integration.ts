import { IntegrationService } from '../../app/integration.js';
import { MergeService } from '../../app/merge.js';
import { GateService } from '../../app/gate-service.js';
import { newEvent } from '../../app/events.js';
import { UserError } from '../../domain/errors.js';
import { integrationGateProblem } from '../../domain/integration-gate.js';
import { assuranceService } from '../test-lock-wiring.js';
import type { CliContext } from '../context.js';

export function registerIntegration(ctx: CliContext): void {
  const { program, options, write, repo, withJournal } = ctx;
  const integration = program.command('integration');
  integration
    .command('gate')
    .argument('<goalId>')
    .requiredOption('--commit <sha>', 'the integration commit')
    .requiredOption('--reason <text>', 'why this commit is the integration')
    .option('--by <name>', 'who asks, for the log', 'lead')
    .description('Lead: gate the integration commit now; the request is an event with its reason')
    .action((goalId: string, { commit, reason, by }: { commit: string; reason: string; by: string }) =>
      withJournal(journal => {
        const state = journal.getGoal(goalId);
        if (!state) throw new UserError(`Goal not found: ${goalId}`);
        const problem = integrationGateProblem(state, commit, reason);
        if (problem) throw new UserError(problem);
        journal.append(
          newEvent(goalId, 'integration-gate-requested', {
            commit,
            reason,
            by,
          }),
        );
        const report = new GateService(journal, {
          inspector: options.inspector,
          ...options.gate,
          assurance: assuranceService(ctx, journal, goalId),
        }).run(goalId, repo(), {
          deliveryCommit: commit,
        });
        write(`Integration gate ${report.result} on ${commit}`);
      }),
    );
  integration
    .command('prepare')
    .argument('<goalId>')
    .action((goalId: string) =>
      withJournal(journal => {
        write(JSON.stringify(new IntegrationService(journal, options.inspector).prepare(goalId, repo())));
      }),
    );
  integration
    .command('complete')
    .argument('<goalId>')
    .requiredOption('--commit <sha>')
    .option('--conflict-resolution <text>')
    .action((goalId: string, { commit, conflictResolution }: { commit: string; conflictResolution?: string }) =>
      withJournal(journal => {
        const input = { commitRef: commit, conflictResolution };
        const current = journal.getGoal(goalId)?.gate;
        // The controller gates the integration commit itself; a red result wakes the Lead on the next tick.
        if (current?.deliveryCommit !== input.commitRef || current.result !== 'green') {
          const report = new GateService(journal, {
            inspector: options.inspector,
            ...options.gate,
            assurance: assuranceService(ctx, journal, goalId),
          }).run(goalId, repo(), { deliveryCommit: input.commitRef });
          write(`Integration gate ${report.result} on ${input.commitRef}`);
          if (report.result !== 'green') throw new Error(`Integration gate is ${report.result}`);
        }
        new IntegrationService(journal, options.inspector).complete(goalId, repo(), input);
        write(`Integrated and verified ${goalId}`);
      }),
    );
  integration
    .command('merge')
    .argument('<goalId>')
    .requiredOption('--source <commit>')
    .requiredOption('--target <branch>')
    .action((goalId: string, { source, target }: { source: string; target: string }) =>
      withJournal(journal => {
        const mergeCommit = new MergeService(journal).merge(goalId, repo(), source, target);
        const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).runPostMerge(
          goalId,
          repo(),
        );
        write(`Merged ${goalId}: ${mergeCommit}; post-merge gate ${report.result}`);
      }),
    );
}
