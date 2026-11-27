import { exitFor, jsonResult, verdictOf, type Verdict } from '../json-result.js';
import type { GateReport } from '../../domain/gate.js';
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
import { closeLayerProblems } from '../../domain/close-gate.js';
import { withGateLease } from '../../store/lease.js';
import { assuranceService } from '../test-lock-wiring.js';
import { InvariantError, UserError } from '../../domain/errors.js';
import { ON_BEHALF_FLAGS, ON_BEHALF_HELP } from '../human-confirm.js';
import type { CliContext } from '../context.js';
import type { ProjectJournal } from '../../store/journal.js';

function closeResult(journal: ProjectJournal, id: string, verdict: Verdict, report?: GateReport) {
  const current = journal.getGoal(id);
  if (!current) throw new InvariantError(`Goal not found after close: ${id}`);
  return {
    ...jsonResult('outcome close', current, verdict, report),
    status: current.status,
    merge: current.merge ?? null,
  };
}

export function registerOutcome(ctx: CliContext): void {
  const { program, options, write, repo, withJournal, withJournalAsync, assertHuman } = ctx;
  const outcome = program.command('outcome');
  // Gate D: the Human reads the Verification Report, decides the outcome and, only here, whether to merge.
  for (const decision of ['close', 'revise', 'stop'] as const) {
    const command = outcome.command(decision).argument('<id>');
    if (decision === 'close')
      command
        .option('--json', 'emit JSON')
        .option('--merge-to <branch>', 'authorize and perform one merge of the gated commit')
        .option('--by <name>', 'who decided', 'human');
    command.option(ON_BEHALF_FLAGS, ON_BEHALF_HELP);
    command.action((id: string, flags: { mergeTo?: string; by?: string; onBehalf?: string; json?: boolean }) =>
      withJournalAsync(async journal => {
        const confirmation = await assertHuman(`outcome ${decision}`, id, flags.onBehalf);
        const state = journal.getGoal(id);
        let closeReport: GateReport | undefined;
        if (decision === 'close') {
          if (state?.status !== 'verified') throw new Error('Verified Goal required before closing');
          // Before any merge: a close that is going to be refused must not have merged anything first.
          const problems = closeProblems(state);
          if (problems.length) throw new UserError(problems.join('; '));
          // The close-stage layers run on the commit the Goal was verified on, before anything is merged or closed.
          if (state.setupVersion !== undefined) {
            const gate = new GateService(journal, {
              inspector: options.inspector,
              ...options.gate,
              assurance: assuranceService(ctx, journal, id),
            });
            const held = await withGateLease(ctx.home(), () => Promise.resolve(gate.runClose(id, repo())));
            if (!held.ran)
              throw new UserError(
                `Another gate is running for this project (pid ${held.holder}): wait for it, then close again`,
              );
            closeReport = held.value;
            if (!flags.json)
              write(`Close-stage layers ${held.value?.result ?? 'did not run'} on ${state.verifiedCommit}`);
            const blocked = closeLayerProblems(journal.getGoal(id)!);
            if (blocked.length && flags.json) {
              const verdict =
                closeReport && closeReport.result !== 'green' ? verdictOf(closeReport.result) : 'unverifiable';
              process.exitCode = exitFor(verdict);
              write(JSON.stringify({ ...closeResult(journal, id, verdict, closeReport), problems: blocked }));
              return;
            }
            if (blocked.length)
              throw new UserError(
                `${blocked.join('; ')}. Fix it and submit again, or approve an exception (apos exception approve --kind floor-reduced --ref ${id}:close:<layer>); a verified Goal whose verified commit cannot pass is revised with \`apos outcome revise\``,
              );
          }
          if (flags.mergeTo) {
            const merges = new MergeService(journal);
            merges.authorize(id, flags.mergeTo, flags.by ?? 'human');
            const mergeCommit = merges.merge(id, repo(), state.gate!.deliveryCommit, flags.mergeTo);
            let report: GateReport;
            try {
              report = new GateService(journal, { inspector: options.inspector, ...options.gate }).runPostMerge(
                id,
                repo(),
              );
            } catch (error) {
              if (!flags.json) throw error;
              process.exitCode = 3;
              write(
                JSON.stringify({
                  ...closeResult(journal, id, 'unverifiable'),
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
              return;
            }
            if (!flags.json) write(`Merged ${id}: ${mergeCommit}; post-merge gate ${report.result}`);
            if (report.result !== 'green' && flags.json) {
              const verdict = verdictOf(report.result);
              process.exitCode = exitFor(verdict);
              write(JSON.stringify(closeResult(journal, id, verdict, report)));
              return;
            }
            if (report.result !== 'green')
              throw new Error(`Post-merge gate is ${report.result}; Goal stays verified, not closed`);
          }
          // Merged but not yet closed (the post-merge gate was pending or red): rerun it so a confirmation on the merge commit can count.
          if (!flags.mergeTo && state.merge && state.postMergeGate?.result !== 'green') {
            let report: GateReport;
            try {
              report = new GateService(journal, { inspector: options.inspector, ...options.gate }).runPostMerge(
                id,
                repo(),
              );
            } catch (error) {
              if (!flags.json) throw error;
              process.exitCode = 3;
              write(
                JSON.stringify({
                  ...closeResult(journal, id, 'unverifiable'),
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
              return;
            }
            if (!flags.json) write(`Post-merge gate ${report.result} on ${state.merge.mergeCommit}`);
            if (report.result !== 'green' && flags.json) {
              const verdict = verdictOf(report.result);
              process.exitCode = exitFor(verdict);
              write(JSON.stringify(closeResult(journal, id, verdict, report)));
              return;
            }
            if (report.result !== 'green')
              throw new UserError(`Post-merge gate is ${report.result}; Goal stays verified, not closed`);
          }
        }
        new VerificationService(journal).recordOutcome(id, decision, confirmation);
        if (decision === 'close' && flags.json) {
          const verdict = closeReport ? verdictOf(closeReport.result) : 'unverifiable';
          process.exitCode = exitFor(verdict);
          write(JSON.stringify(closeResult(journal, id, verdict, closeReport)));
        } else write(`${decision} ${id}`);
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
          const items = buildHumanInbox(journal, ctx.now());
          if (!items.length) write('Inbox is clean: nothing waits for the Human.');
          for (const item of items) write(`${item.goalId}\t${item.kind}\t${item.detail}`);
        });
        return;
      }
      if (!existsSync(join(repo(), '.apos', 'project.yaml'))) throw new Error('Run apos init first');
      const homeDir = options.home ?? controllerHome(repo());
      const timeoutMs = parseDurationMs(flags.timeout);
      const check = () => {
        const current = filterInboxSince(buildHumanInbox(readOnlyRepo(homeDir), ctx.now()), flags.since);
        return current.fresh.length ? current : undefined;
      };
      let hit = check();
      if (!hit && flags.wait) {
        hit = await watchEvents(homeDir, timeoutMs, check);
      }
      if (!hit && flags.wait) {
        const snapshot = readOnlyRepo(homeDir);
        const goals = snapshot.listGoals();
        const cursor = filterInboxSince(buildHumanInbox(snapshot, ctx.now()), flags.since).cursor;
        const summary = goals.length ? goals.map(g => `${g.spec.id}:${g.status}`).join(', ') : 'no Goals';
        if (flags.json)
          write(
            JSON.stringify({
              ...jsonResult('inbox', undefined, 'unverifiable'),
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
      const result = hit ?? filterInboxSince(buildHumanInbox(readOnlyRepo(homeDir), ctx.now()), flags.since);
      process.exitCode = flags.json ? 3 : 0;
      if (flags.json) {
        write(
          JSON.stringify({
            ...jsonResult('inbox', undefined, 'unverifiable'),
            cursor: result.cursor,
            items: result.fresh,
          }),
        );
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
