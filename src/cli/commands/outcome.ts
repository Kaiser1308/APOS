import { newEvent } from '../../app/events.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HandoffService } from '../../app/handoff.js';
import type { HandoffTarget } from '../../domain/transitions.js';
import { MergeService } from '../../app/merge.js';
import { buildInbox } from '../../app/inbox.js';
import { DEFAULT_UI_PORT, startUi } from '../../ui/server.js';
import { VerificationService } from '../../app/verification.js';
import { GateService } from '../../app/gate.js';
import { loadProfiles } from '../../runtime/brief.js';
import { controllerHome } from '../../store/event-log.js';
import type { Role } from '../../domain/runtime-refs.js';
import type { CliContext } from '../context.js';

export function registerOutcome(ctx: CliContext): void {
  const { program, options, write, runtime, repo, home, withJournal, withJournalAsync, assertHuman, applyProfile } =
    ctx;
  program
    .command('handoff')
    .argument('<goalId>')
    .description(
      'Human: move a stuck owner (for example out of quota) to a fresh agent on the same worktree; no attempt is spent',
    )
    .option('--package <id>', 'the Worker of this package instead of the Lead')
    .option('--reviewer', 'the reviewer instead of the Lead')
    .option('--agent <id>', 'also make this agent the profile of that role (as `profile set`)')
    .option('--model <id>')
    .option('--effort <level>', 'needs --model')
    .action(
      (
        goalId: string,
        flags: { package?: string; reviewer?: boolean; agent?: string; model?: string; effort?: string },
      ) =>
        withJournalAsync(async journal => {
          assertHuman(journal, 'handoff');
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
    .action(() =>
      withJournal(journal => {
        const items = buildInbox(journal);
        if (!items.length) write('Inbox is clean: nothing waits for the Human.');
        for (const item of items) write(`${item.goalId}\t${item.kind}\t${item.detail}`);
      }),
    );
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
