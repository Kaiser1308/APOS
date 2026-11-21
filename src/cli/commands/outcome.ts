import { newEvent } from '../../app/events.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HandoffService } from '../../app/handoff.js';
import { LeadTransferService } from '../../app/lead-transfer.js';
import type { HandoffTarget } from '../../domain/transitions.js';
import { MergeService } from '../../app/merge.js';
import {
  buildHumanInbox,
  controllerActive,
  filterInboxSince,
  parseDurationMs,
  readOnlyRepo,
  watchEvents,
} from '../../app/wait.js';
import { DEFAULT_UI_PORT, startUi } from '../../ui/server.js';
import { VerificationService } from '../../app/verification.js';
import { GateService } from '../../app/gate-service.js';
import { loadProfiles } from '../../runtime/brief.js';
import { controllerHome } from '../../store/event-log.js';
import { UserError } from '../../domain/errors.js';
import type { Role } from '../../domain/runtime-refs.js';
import type { CliContext } from '../context.js';

export function registerOutcome(ctx: CliContext): void {
  const {
    program,
    options,
    write,
    writeError,
    runtime,
    repo,
    home,
    withJournal,
    withJournalAsync,
    assertHuman,
    applyProfile,
  } = ctx;
  program
    .command('handoff')
    .argument('<goalId>')
    .description(
      'Human: move a stuck owner (for example out of quota) to a fresh agent on the same worktree; no attempt is spent',
    )
    .option(
      '--to-bot <name>',
      'give the Lead role to this Orca bot (name or id); it coordinates through APOS commands and never codes',
    )
    .option('--to-apos', 'give the Lead role back from its bot to a fresh APOS-dispatched Lead')
    .option('--by <name>', 'who decided a Lead transfer', 'human')
    .option('--package <id>', 'the Worker of this package instead of the Lead')
    .option('--reviewer', 'the reviewer instead of the Lead')
    .option('--agent <id>', 'also make this agent the profile of that role (as `profile set`)')
    .option('--model <id>')
    .option('--effort <level>', 'needs --model')
    .action(
      (
        goalId: string,
        flags: {
          package?: string;
          reviewer?: boolean;
          agent?: string;
          model?: string;
          effort?: string;
          toBot?: string;
          toApos?: boolean;
          by: string;
        },
      ) =>
        withJournalAsync(async journal => {
          assertHuman(journal, 'handoff');
          if (flags.toBot || flags.toApos) {
            if ([flags.toBot, flags.toApos, flags.package, flags.reviewer].filter(Boolean).length > 1)
              throw new UserError('Pass one of --to-bot, --to-apos, --package or --reviewer');
            if (!flags.by.trim()) throw new UserError('--by needs a name');
            if ((flags.model || flags.effort) && !flags.agent) throw new UserError('--model and --effort need --agent');
            const transfers = new LeadTransferService(journal, runtime, () => loadProfiles(home()));
            if (flags.toBot) {
              if (flags.agent) throw new UserError('--agent does not apply to a bot');
              const moved = await transfers.toBot(goalId, flags.toBot, flags.by, repo());
              write(`Lead of ${goalId} moved to bot ${moved.bot.name} (${moved.bot.id}); stopped ${moved.from}`);
              if (moved.warning) write(`warning: ${moved.warning}`);
              return;
            }
            if (flags.agent) applyProfile(['lead'], { agent: flags.agent, model: flags.model, effort: flags.effort });
            const back = await transfers.back(goalId, flags.by, repo());
            write(
              `Lead of ${goalId} returned from its bot: ${back.note}${back.dispatchId ? ` (${back.dispatchId})` : ''}`,
            );
            return;
          }
          if (flags.package && flags.reviewer) throw new Error('Pass --package or --reviewer, not both');
          if ((flags.model || flags.effort) && !flags.agent) throw new Error('--model and --effort need --agent');
          const target: HandoffTarget = flags.package
            ? { kind: 'package', packageId: flags.package }
            : flags.reviewer
              ? { kind: 'reviewer' }
              : { kind: 'lead' };
          const role: Role = target.kind === 'package' ? 'worker' : target.kind === 'reviewer' ? 'reviewer' : 'lead';
          // Written first: the runtime reads the role profile when it starts the new agent.
          if (flags.agent) applyProfile([role], { agent: flags.agent, model: flags.model, effort: flags.effort });
          const result = await new HandoffService(journal, runtime, () => loadProfiles(home())).handoff(
            goalId,
            target,
            repo(),
          );
          write(
            `handed off ${goalId}${flags.package ? ` ${flags.package}` : flags.reviewer ? ' reviewer' : ''} to ${loadProfiles(home())[role].agent} (${result.dispatchId})`,
          );
          if (result.warning) write(`warning: ${result.warning}`);
        }),
    );

  const outcome = program.command('outcome');
  // Gate D: the Human reads the Verification Report, decides the outcome and, only here, whether to merge.
  for (const decision of ['close', 'revise', 'stop'] as const) {
    const command = outcome.command(decision).argument('<id>');
    if (decision === 'close')
      command
        .option('--merge-to <branch>', 'authorize and perform one merge of the gated commit')
        .option('--by <name>', 'who decided', 'human');
    command.action((id: string, flags: { mergeTo?: string; by?: string }) =>
      withJournalAsync(async journal => {
        assertHuman(journal, `outcome ${decision}`);
        const state = journal.getGoal(id);
        if (decision === 'close') {
          if (state?.status !== 'verified') throw new Error('Verified Goal required before closing');
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
          if (runtime.releaseWorker)
            for (const dispatchId of Object.keys(state.settlements ?? {})) await runtime.releaseWorker(dispatchId);
        }
        new VerificationService(journal).recordOutcome(id, decision);
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
        if (!controllerActive(homeDir))
          writeError(
            'warning: no active controller watch detected (no tick in the last 2 min); run `apos controller watch` so Goals can advance.',
          );
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
