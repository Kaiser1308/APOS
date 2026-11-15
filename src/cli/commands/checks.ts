import { newEvent } from '../../app/events.js';
import type { Evidence } from '../../domain/contracts.js';
import { ReviewService } from '../../app/review.js';
import { MetricsService } from '../../app/metrics.js';
import { VerificationService } from '../../app/verification.js';
import { GateService } from '../../app/gate.js';
import type { CliContext } from '../context.js';

export function registerChecks(ctx: CliContext): void {
  const { program, options, write, repo, withJournal, assertHuman, readJsonFile } = ctx;
  const gate = program
    .command('gate')
    .description('controller-run checks on exact commits; owner claims are not evidence');
  gate
    .command('run')
    .argument('<goalId>')
    .requiredOption('--commit <sha>', 'delivery or integration commit')
    .option('--base <sha>', 'override the proposal base commit')
    .action((goalId: string, { commit, base }: { commit: string; base?: string }) =>
      withJournal(journal => {
        const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).run(goalId, repo(), {
          deliveryCommit: commit,
          baseCommit: base,
        });
        write(
          JSON.stringify({
            gateId: report.gateId,
            result: report.result,
            deliveryCommit: report.deliveryCommit,
            checks: report.checks.map(item => ({
              checkId: item.checkId,
              status: item.status,
              reason: item.reason,
              newFailures: item.newFailures,
            })),
          }),
        );
      }),
    );
  gate
    .command('confirm')
    .argument('<goalId>')
    .argument('<checkId>')
    .requiredOption('--commit <sha>')
    .requiredOption('--by <name>')
    .requiredOption('--note <text>')
    .action((goalId: string, checkId: string, { commit, by, note }: { commit: string; by: string; note: string }) =>
      withJournal(journal => {
        assertHuman(journal, 'gate confirm');
        new GateService(journal, { inspector: options.inspector, ...options.gate }).confirmManual(goalId, {
          checkId,
          deliveryCommit: commit,
          by,
          note,
        });
        write(`Confirmed ${checkId} on ${commit}`);
      }),
    );
  const review = program.command('review');
  review
    .command('submit')
    .argument('<goalId>')
    .requiredOption('--file <json>')
    .action((goalId: string, { file }: { file: string }) =>
      withJournal(journal => {
        assertHuman(journal, 'review submit'); // the controller dispatches and reads reviewers itself; no agent may post a verdict
        const result = new ReviewService(journal).submit(goalId, readJsonFile(file));
        write(`Reviewed ${result.subject}${result.packageId ? ` ${result.packageId}` : ''}: ${result.result}`);
      }),
    );
  const metrics = program.command('metrics');
  metrics
    .command('show')
    .argument('<goalId>')
    .action((goalId: string) =>
      withJournal(journal => write(JSON.stringify(new MetricsService(journal).show(goalId)))),
    );

  const evidence = program.command('evidence');
  evidence
    .command('add')
    .argument('<id>')
    .requiredOption('--file <json>')
    .action((id: string, { file }: { file: string }) =>
      withJournal(journal => {
        new VerificationService(journal).submitEvidence(id, readJsonFile(file) as Evidence);
        write(`Recorded evidence for ${id}`);
      }),
    );
  evidence
    .command('show')
    .argument('<id>')
    .action((id: string) => withJournal(journal => write(JSON.stringify(journal.getGoal(id)?.evidence ?? []))));
  const decision = program.command('decision');
  decision
    .command('record')
    .argument('<id>')
    .requiredOption('--note <text>')
    .action((id: string, { note }: { note: string }) =>
      withJournal(journal => {
        if (!note.trim()) throw new Error('Decision note required');
        journal.append(newEvent(id, 'decision-logged', { note }));
        write(`Recorded decision for ${id}`);
      }),
    );
  const blocker = program.command('blocker');
  blocker
    .command('report')
    .argument('<id>')
    .requiredOption('--kind <kind>')
    .requiredOption('--note <text>')
    .action((id: string, { kind, note }: { kind: string; note: string }) =>
      withJournal(journal => {
        if (!['technical', 'product', 'external'].includes(kind) || !note.trim())
          throw new Error('Valid blocker kind and note required');
        journal.append(newEvent(id, 'blocked', { kind, note }));
        write(`Blocked ${id}`);
      }),
    );
  blocker
    .command('resolve')
    .argument('<id>')
    .requiredOption('--note <text>')
    .action((id: string, { note }: { note: string }) =>
      withJournal(journal => {
        if (!note.trim()) throw new Error('Resolution note required');
        assertHuman(journal, 'blocker resolve');
        journal.append(newEvent(id, 'decision-logged', { note }));
        journal.append(newEvent(id, 'unblocked'));
        write(`Unblocked ${id}`);
      }),
    );
}
