import { newEvent } from '../../app/events.js';
import {
  assertProposalRationale,
  parseExecutionProposal,
  proposalRationale,
  type PhaseCheckpoint,
} from '../../domain/contracts.js';
import { SoloService } from '../../app/solo.js';
import { assertLeadTerminal, currentLeadRef } from '../../app/lead.js';
import { wakeBot } from '../../app/bot-lead.js';
import { UserError } from '../../domain/errors.js';
import { assertExecutionSettled } from '../../app/replan.js';
import { GoalRegistryService } from '../../app/registry.js';
import { assertMultiWpPlannable } from '../../domain/packages.js';
import type { CliContext } from '../context.js';

export function registerLead(ctx: CliContext): void {
  const {
    program,
    write,
    runtime,
    repo,
    withJournal,
    withJournalAsync,
    assertHuman,
    checkInBot,
    readJsonFile,
    requestDispatch,
    awaitController,
  } = ctx;
  const lead = program.command('lead');
  lead.command('recommend').action(() =>
    withJournal(journal => {
      const candidate = new GoalRegistryService(journal).recommend();
      write(candidate ? `${candidate.spec.id}: ${candidate.spec.outcome}` : 'No eligible Goal');
    }),
  );
  lead
    .command('start')
    .argument('<id>')
    .description(
      'Human: ask the controller to dispatch the Lead of a selected Goal (goal select does this; use it to retry)',
    )
    .action((id: string) =>
      withJournal(journal => {
        assertHuman(journal, 'lead start');
        requestDispatch(journal, id, { kind: 'lead-start' });
      }),
    );
  lead
    .command('wake')
    .argument('<id>')
    .requiredOption('--note <text>', 'your decision, delivered to the Lead')
    .description('Human: wake a Lead that ended its turn before its plan was accepted, on its own terminal')
    .action((id: string, { note }: { note: string }) =>
      withJournalAsync(async journal => {
        assertHuman(journal, 'lead wake');
        if (!note.trim()) throw new Error('Wake note required');
        if (journal.getGoal(id)?.leadBot) {
          // A bot Lead has no terminal to wake: the Human's note goes to it by Orca mail, recorded like any wake.
          const sent = await wakeBot(journal, runtime, id, repo(), [
            `the Human says (${new Date().toISOString()}): ${note}`,
          ]);
          write(`Woke Lead ${id}: ${sent.join('; ')}`);
          return;
        }
        if (!journal.getGoal(id)?.lead) throw new UserError(`No APOS-dispatched Lead for ${id}`);
        requestDispatch(journal, id, { kind: 'lead-wake', note });
      }),
    );
  lead
    .command('ack')
    .argument('<id>')
    .description(
      "bot Lead: run first on every APOS wake; it tells APOS the wake reached this chat and records the chat's mailbox",
    )
    .action((id: string) =>
      withJournal(journal => {
        const state = journal.getGoal(id);
        if (!state) throw new UserError(`Goal does not exist: ${id}`);
        if (!state.leadBot) throw new UserError(`No bot holds the Lead of ${id}; only a bot Lead acks wakes`);
        assertLeadTerminal(state, process.env.ORCA_TERMINAL_HANDLE, 'lead ack', process.cwd(), () =>
          runtime.callerBot?.(),
        );
        const { acked, mailbox } = checkInBot(journal, id, 'lead ack')!;
        write(
          `${id}: ${acked.length ? `acked wake ${acked.join(', ')}` : 'no wake waiting for an ack'}; APOS expects your wake mail in ${mailbox ?? 'an unknown mailbox (Orca did not name the mailbox of this chat)'}`,
        );
      }),
    );
  lead
    .command('propose')
    .requiredOption('--file <json>')
    .action(({ file }: { file: string }) =>
      withJournalAsync(async journal => {
        const parsed = parseExecutionProposal(readJsonFile(file));
        assertProposalRationale(parsed);
        const current = journal.getGoal(parsed.goalId);
        if (!current) throw new Error(`Goal does not exist: ${parsed.goalId}`);
        const leadState = assertLeadTerminal(
          current,
          process.env.ORCA_TERMINAL_HANDLE,
          'lead propose',
          process.cwd(),
          () => runtime.callerBot?.(),
        );
        checkInBot(journal, parsed.goalId, 'lead propose');
        // The gate compares against the commit the Lead's worktree was cut from: the code it actually read.
        if (parsed.baseCommit && parsed.baseCommit.toLowerCase() !== leadState.ref.baseCommit.toLowerCase())
          throw new Error(
            `Proposal baseCommit ${parsed.baseCommit} differs from the Lead's worktree base ${leadState.ref.baseCommit}`,
          );
        const planned = { ...parsed, baseCommit: leadState.ref.baseCommit };
        const state = current;
        const proposal =
          planned.sourceSha256 || !state ? planned : { ...planned, sourceSha256: state.spec.source.sha256 };
        if (!state || proposal.goalVersion !== state.spec.version)
          throw new Error('Proposal targets stale Goal version');
        assertMultiWpPlannable(proposal);
        const mapped = new Set(proposal.acceptanceMapping.map(item => item.acceptanceId));
        if (state.spec.acceptance.some(item => !mapped.has(item.id)))
          throw new Error('Every Goal acceptance criterion needs a verification mapping');
        if (state.proposal) await assertExecutionSettled(state, runtime);
        journal.append(newEvent(proposal.goalId, state.proposal ? 'proposal-revised' : 'proposal-drafted', proposal));
        write(`Proposed ${proposal.id}`);
      }),
    );

  const execution = program.command('execution');
  // No Human gate on HOW: the Lead commits its plan, the controller machine-checks it and dispatches.
  // A Multi-WP plan only notifies the Human.
  lead
    .command('commit')
    .argument('<id>')
    .description('Lead commits its plan; the controller checks it and dispatches')
    .option('--terminal <handle>', 'deprecated: APOS knows the Lead terminal it dispatched; if given it must match')
    .option('--worktree <selector>', 'worktree selector of the Lead terminal')
    .action(async (id: string, flags: { terminal?: string; worktree?: string }) =>
      withJournalAsync(async journal => {
        const state = journal.getGoal(id);
        if (!state) throw new Error(`Goal does not exist: ${id}`);
        const leadState = assertLeadTerminal(
          state,
          process.env.ORCA_TERMINAL_HANDLE,
          'lead commit',
          process.cwd(),
          () => runtime.callerBot?.(),
        );
        checkInBot(journal, id, 'lead commit');
        if (!state.proposal)
          throw new Error(
            `Current proposal required: ${id} has no proposal yet (run apos lead propose --file <execution.json> first)`,
          );
        assertProposalRationale(
          state.proposal,
          `. This saved proposal predates that field: add a "rationale" string to your execution JSON, re-run apos lead propose --file <execution.json>, then apos lead commit ${id}`,
        );
        assertMultiWpPlannable(state.proposal);
        if (flags.terminal && flags.terminal !== leadState.ref.terminal)
          throw new Error(
            `--terminal ${flags.terminal} is not the Lead terminal APOS dispatched (${leadState.ref.terminal}); leave it out`,
          );
        journal.append(
          newEvent(id, 'proposal-approved', { by: 'controller', proposalVersion: state.proposal.version }),
        );
        if (state.proposal.mode === 'multi-wp') {
          // Wake-ups go to the Lead's own terminal; this dispatch is its current turn, so none arrives until it ends.
          const ref = currentLeadRef(leadState);
          journal.append(
            newEvent(id, 'lead-woken', {
              events: [],
              dispatchId: ref.dispatchId,
              terminal: leadState.ref.terminal,
              worktree: `id:${leadState.ref.worktreeId}`,
              runId: ref.runId,
            }),
          );
          const notice = {
            kind: 'multi-wp',
            goalId: id,
            packages: Object.keys(state.packages ?? {}),
            splitRationale: proposalRationale(state.proposal),
            estimatedCost: state.proposal.estimatedCost,
          };
          journal.append(newEvent(id, 'human-notified', notice));
          write(
            `NOTICE ${id}: Lead chose Multi-WP (${notice.packages.length} packages, est. ${notice.estimatedCost?.spendUsd} USD / ${notice.estimatedCost?.wallMinutes} min): ${notice.splitRationale}`,
          );
          awaitController(`Accepted ${id}: the controller dispatches its ready packages at its next tick.`);
        } else if (state.leadBot) {
          awaitController(
            `Accepted ${id}: the controller dispatches a Solo owner to deliver it at its next tick; you check, you do not write code.`,
          );
        } else {
          // The APOS Lead is the owner already running: recording that is a log entry, no Orca call, so it happens now
          // and the Lead can checkpoint and deliver at once.
          const ref = await new SoloService(journal, runtime).adopt(id);
          write(
            `Accepted ${id}: you (Lead ${ref.dispatchId}) are the Solo owner. Deliver in this worktree and commit your report.`,
          );
        }
      }),
    );
  execution
    .command('start')
    .argument('<id>')
    .description('the controller records the owner of an accepted Solo plan at its next tick (lead commit leads to it)')
    .action((id: string) =>
      withJournal(journal => {
        const state = journal.getGoal(id);
        if (!state?.proposal?.mode.startsWith('solo') || state.status !== 'ready')
          throw new UserError(`${id} has no accepted Solo plan waiting for its owner`);
        awaitController(`${id}: the controller starts the owner of its accepted Solo plan at its next tick.`);
      }),
    );
  execution
    .command('checkpoint')
    .argument('<id>')
    .requiredOption('--file <json>')
    .action((id: string, { file }: { file: string }) =>
      withJournal(journal => {
        const checkpoint = readJsonFile(file) as PhaseCheckpoint;
        if (
          typeof checkpoint.phase !== 'string' ||
          !checkpoint.phase.trim() ||
          typeof checkpoint.progress !== 'string' ||
          !checkpoint.progress.trim() ||
          !Array.isArray(checkpoint.evidenceRefs) ||
          !checkpoint.evidenceRefs.every(item => typeof item === 'string')
        )
          throw new Error('Phase checkpoint requires phase, progress and evidenceRefs');
        journal.append(newEvent(id, 'checkpointed', checkpoint));
        write(`Checkpointed ${id}: ${checkpoint.phase}`);
      }),
    );
  execution
    .command('resume')
    .argument('<id>')
    .action((id: string) =>
      withJournal(journal => {
        requestDispatch(journal, id, { kind: 'execution-resume' });
      }),
    );
  execution
    .command('retry')
    .argument('<id>')
    .requiredOption('--reason <text>')
    .action((id: string, { reason }: { reason: string }) =>
      withJournal(journal => {
        if (!reason.trim()) throw new Error('Retry reason required');
        if (!journal.getGoal(id)?.resumeIntent)
          journal.append(newEvent(id, 'checkpointed', { phase: 'repair', progress: reason, evidenceRefs: [] }));
        requestDispatch(journal, id, { kind: 'execution-resume' });
      }),
    );
  execution
    .command('abandon-intent')
    .argument('<id>')
    .requiredOption('--key <key>')
    .requiredOption('--reason <text>')
    .description('Human: drop a dispatch/resume intent after confirming in Orca that it created nothing')
    .action((id: string, flags: { key: string; reason: string }) =>
      withJournal(journal => {
        assertHuman(journal, 'execution abandon-intent');
        journal.append(newEvent(id, 'intent-abandoned', { key: flags.key, reason: `human: ${flags.reason}` }));
        write(`Abandoned intent ${flags.key} for ${id}`);
      }),
    );
  execution
    .command('status')
    .argument('<id>')
    .action((id: string) =>
      withJournal(journal => {
        const state = journal.getGoal(id);
        if (!state) throw new Error(`Unknown Goal: ${id}`);
        write(
          JSON.stringify({
            goalId: id,
            status: state.status,
            proposalVersion: state.proposal?.version,
            runtimeRef: state.runtimeRef,
          }),
        );
      }),
    );
  execution
    .command('reconcile')
    .argument('<id>')
    .action((id: string) =>
      withJournalAsync(async journal => {
        write(`${id}: ${await new SoloService(journal, runtime).reconcile(id)}`);
      }),
    );
  execution
    .command('verify')
    .argument('<id>')
    .option('--commit <sha>', 'delivery commit under review')
    .action((id: string, { commit }: { commit?: string }) =>
      withJournalAsync(async journal => {
        const result = await new SoloService(journal, runtime).verify(id, commit);
        write(`Verified ${id} at ${result.deliveryCommit}: ${result.acceptanceIds.join(', ')}`);
      }),
    );
}
