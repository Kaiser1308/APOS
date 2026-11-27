import { exitFor, jsonResult, verdictOf } from '../json-result.js';
import { IntegrationService } from '../../app/integration.js';
import { MergeService } from '../../app/merge.js';
import { GateService } from '../../app/gate-service.js';
import type { GateReport } from '../../domain/gate.js';
import { newEvent } from '../../app/events.js';
import { withGateLease } from '../../store/lease.js';
import { UserError } from '../../domain/errors.js';
import { integrationGateProblem } from '../../domain/integration-gate.js';
import { assuranceService } from '../test-lock-wiring.js';
import type { CliContext } from '../context.js';

/** What did not pass, one line each, as `package submit` prints it: a red layer is named. */
const reasonsOf = (report: GateReport): string[] =>
  report.checks
    .filter(check => check.status !== 'pass')
    .map(check => `  ${check.checkId} ${check.status}: ${check.reason}`);

export function registerIntegration(ctx: CliContext): void {
  const { program, options, write, repo, withJournal, withJournalAsync } = ctx;
  const integration = program.command('integration');
  integration
    .command('gate')
    .argument('<goalId>')
    .requiredOption('--commit <sha>', 'the integration commit')
    .requiredOption('--reason <text>', 'why this commit is the integration')
    .option('--by <name>', 'who asks, for the log', 'lead')
    .option('--json', 'emit JSON')
    .description('Lead: gate the integration commit now; the request is an event with its reason')
    .action(
      (goalId: string, { commit, reason, by, json }: { commit: string; reason: string; by: string; json?: boolean }) =>
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
          process.exitCode = exitFor(verdictOf(report.result));
          if (json) {
            write(JSON.stringify(jsonResult('integration gate', state, verdictOf(report.result), report)));
            return;
          }
          write(`Integration gate ${report.result} on ${commit}`);
          for (const line of reasonsOf(report)) write(line);
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
          for (const line of reasonsOf(report)) write(line);
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
      withJournalAsync(async journal => {
        const held = await withGateLease(ctx.home(), async () => {
          const mergeCommit = new MergeService(journal).merge(goalId, repo(), source, target);
          const report = new GateService(journal, {
            inspector: options.inspector,
            ...options.gate,
            assurance: assuranceService(ctx, journal, goalId),
          }).runPostMerge(goalId, repo());
          write(`Merged ${goalId}: ${mergeCommit}; post-merge gate ${report.result}`);
        });
        if (!held.ran)
          throw new UserError(
            `Another gate is running for this project (pid ${held.holder}): wait for it, then merge again`,
          );
      }),
    );
}
