import { newEvent } from '../../app/events.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MergeService } from '../../app/merge.js';
import { buildHumanInbox, filterInboxSince, parseDurationMs, readOnlyRepo, watchEvents } from '../../app/wait.js';
import { DEFAULT_UI_PORT, startUi } from '../../ui/server.js';
import { VerificationService } from '../../app/verification.js';
import { GateService } from '../../app/gate-service.js';
import { controllerHome } from '../../store/event-log.js';
import { closeProblems } from '../../domain/transitions.js';
import { UserError } from '../../domain/errors.js';
import { ON_BEHALF_FLAGS, ON_BEHALF_HELP } from '../human-confirm.js';
import type { CliContext } from '../context.js';

export function registerOutcome(ctx: CliContext): void {
  const { program, options, write, repo, withJournal, withJournalAsync, assertHuman } = ctx;
  const outcome = program.command('outcome');
  // Gate D: the Human reads the Verification Report, decides the outcome and, only here, whether to merge.
  for (const decision of ['close', 'revise', 'stop'] as const) {
    const command = outcome.command(decision).argument('<id>');
    if (decision === 'close')
      command
        .option('--merge-to <branch>', 'authorize and perform one merge of the gated commit')
        .option('--by <name>', 'who decided', 'human');
    command.option(ON_BEHALF_FLAGS, ON_BEHALF_HELP);
    command.action((id: string, flags: { mergeTo?: string; by?: string; onBehalf?: string }) =>
      withJournalAsync(async journal => {
        const confirmation = await assertHuman(`outcome ${decision}`, id, flags.onBehalf);
        const state = journal.getGoal(id);
        if (decision === 'close') {
          if (state?.status !== 'verified') throw new Error('Verified Goal required before closing');
          // Before any merge: a close that is going to be refused must not have merged anything first.
          const problems = closeProblems(state);
          if (problems.length) throw new UserError(problems.join('; '));
          if (flags.mergeTo) {
            const merges = new MergeService(journal);
            merges.authorize(id, flags.mergeTo, flags.by ?? 'human');
            const mergeCommit = merges.merge(id, repo(), state.gate!.deliveryCommit, flags.mergeTo);
            const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).runPostMerge(
              id,
              repo(),
            );
            write(`Merged ${id}: ${mergeCommit}; post-merge gate ${report.result}`);
            if (report.result !== 'green')
              throw new Error(`Post-merge gate is ${report.result}; Goal stays verified, not closed`);
          }
          // Merged but not yet closed (the post-merge gate was pending or red): rerun it so a confirmation on the merge commit can count.
          if (!flags.mergeTo && state.merge && state.postMergeGate?.result !== 'green') {
            const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).runPostMerge(
              id,
              repo(),
            );
            write(`Post-merge gate ${report.result} on ${state.merge.mergeCommit}`);
            if (report.result !== 'green')
              throw new UserError(`Post-merge gate is ${report.result}; Goal stays verified, not closed`);
          }
        }
        new VerificationService(journal).recordOutcome(id, decision, confirmation);
        write(`${decision} ${id}`);
      }),
    );
  }
  program
    .command('inbox')
    .description('what needs the Human: notices, blocked Goals, verified Goals awaiting outcome')
    .option('--wait', 'block until an item needs the Human')
    .option('--timeout <dur>', 'max time to wait (e.g. 30s, 5m)', '5m')
    .option('--since <cursor>', 'report only items newer than this cursor')
    .option('--json', 'emit machine-readable JSON')
    .action(async (flags: { wait?: boolean; timeout?: string; since?: string; json?: boolean }) => {
      if (!flags.wait && !flags.since && !flags.json) {
        withJournal(journal => {
          // Same item set as --since, --wait and --json: gates A and B included, as in the UI's "Needs you" (#28).
          const items = buildHumanInbox(journal);
          if (!items.length) write('Inbox is clean: nothing waits for the Human.');
          for (const item of items) write(`${item.goalId}\t${item.kind}\t${item.detail}`);
        });
        return;
      }
      if (!existsSync(join(repo(), '.apos', 'project.yaml'))) throw new Error('Run apos init first');
      const homeDir = options.home ?? controllerHome(repo());
      const timeoutMs = parseDurationMs(flags.timeout);
      const check = () => {
        const current = filterInboxSince(buildHumanInbox(readOnlyRepo(homeDir)), flags.since);
        return current.fresh.length ? current : undefined;
      };
      let hit = check();
      if (!hit && flags.wait) {
        hit = await watchEvents(homeDir, timeoutMs, check);
      }
      if (!hit && flags.wait) {
        const snapshot = readOnlyRepo(homeDir);
        const goals = snapshot.listGoals();
        const cursor = filterInboxSince(buildHumanInbox(snapshot), flags.since).cursor;
        const summary = goals.length ? goals.map(g => `${g.spec.id}:${g.status}`).join(', ') : 'no Goals';
        if (flags.json)
          write(
            JSON.stringify({
              timeout: true,
              cursor,
              items: [],
              goals: goals.map(g => ({ id: g.spec.id, status: g.status })),
            }),
          );
        else write(`timeout after ${flags.timeout ?? '5m'}: ${summary} (cursor: ${cursor})`);
        process.exitCode = 2;
        return;
      }
      const result = hit ?? filterInboxSince(buildHumanInbox(readOnlyRepo(homeDir)), flags.since);
      process.exitCode = 0;
      if (flags.json) {
        write(JSON.stringify({ cursor: result.cursor, items: result.fresh }));
        return;
      }
      if (!result.fresh.length) {
        write('Inbox is clean: nothing waits for the Human.');
        write(`cursor: ${result.cursor}`);
        return;
      }
      for (const item of result.fresh) write(`${item.goalId}\t${item.kind}\t${item.detail}`);
      write(`cursor: ${result.cursor}`);
    });
  program
    .command('ui')
    .description('read-only web view of this project on 127.0.0.1; it never writes controller state')
    .option('--port <n>', 'port to listen on', String(DEFAULT_UI_PORT))
    .action(async ({ port }: { port: string }) => {
      if (!existsSync(join(repo(), '.apos', 'project.yaml'))) throw new Error('Run apos init first');
      const number = Number(port);
      if (!Number.isInteger(number) || number < 0 || number > 65535)
        throw new Error('--port must be an integer from 0 to 65535');
      const server = await startUi(options.home ?? controllerHome(repo()), number);
      write(`APOS UI: http://127.0.0.1:${(server.address() as { port: number }).port}  (read-only; Ctrl+C to stop)`);
    });
  const finding = program.command('finding');
  finding
    .command('record')
    .argument('<id>')
    .requiredOption('--kind <intent_gap|bad_plan|patch|defer>')
    .requiredOption('--note <text>')
    .option('--by <name>', 'who found it', 'lead')
    .action((id: string, flags: { kind: string; note: string; by: string }) =>
      withJournal(journal => {
        journal.append(newEvent(id, 'finding-recorded', { kind: flags.kind, note: flags.note, by: flags.by }));
        write(`Recorded ${flags.kind} for ${id}`);
      }),
    );
}
