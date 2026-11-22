import { newEvent } from '../../app/events.js';
import { assertProposalRationale, parseExecutionProposal, proposalRationale } from '../../domain/contracts.js';
import { GitCommitInspector } from '../../app/integration.js';
import { UserError } from '../../domain/errors.js';
import type { CliContext } from '../context.js';

export function registerLead(ctx: CliContext): void {
  const { program, write, repo, withJournal, withJournalAsync, options, readJsonFile } = ctx;
  const lead = program.command('lead');
  lead
    .command('propose')
    .requiredOption('--file <json>')
    .action(({ file }: { file: string }) =>
      withJournal(journal => {
        const parsed = parseExecutionProposal(readJsonFile(file));
        assertProposalRationale(parsed);
        const current = journal.getGoal(parsed.goalId);
        if (!current) throw new Error(`Goal does not exist: ${parsed.goalId}`);
        // No Lead worktree to read the base from any more: the plan names it, and it must be a real commit.
        const inspector = options.inspector ?? new GitCommitInspector();
        if (!parsed.baseCommit || !inspector.exists(repo(), parsed.baseCommit))
          throw new UserError('proposal.baseCommit must be the full sha of a commit that exists in this repo');
        const planned = parsed;
        const state = current;
        const proposal =
          planned.sourceSha256 || !state ? planned : { ...planned, sourceSha256: state.spec.source.sha256 };
        if (!state || proposal.goalVersion !== state.spec.version)
          throw new Error('Proposal targets stale Goal version');
        const mapped = new Set(proposal.acceptanceMapping.map(item => item.acceptanceId));
        if (state.spec.acceptance.some(item => !mapped.has(item.id)))
          throw new Error('Every Goal acceptance criterion needs a verification mapping');
        journal.append(newEvent(proposal.goalId, state.proposal ? 'proposal-revised' : 'proposal-drafted', proposal));
        write(`Proposed ${proposal.id}`);
      }),
    );

  // No Human gate on HOW: the Lead commits its plan and APOS machine-checks it.
  // A Multi-WP plan only notifies the Human.
  lead
    .command('commit')
    .argument('<id>')
    .description('Lead commits its plan; APOS machine-checks it. Delivery then goes through `apos package submit`')
    .option('--by <name>', 'who commits, for the log', 'lead')
    .action(async (id: string, flags: { by: string }) =>
      withJournalAsync(async journal => {
        const state = journal.getGoal(id);
        if (!state) throw new Error(`Goal does not exist: ${id}`);
        if (!state.proposal)
          throw new Error(
            `Current proposal required: ${id} has no proposal yet (run apos lead propose --file <execution.json> first)`,
          );
        assertProposalRationale(
          state.proposal,
          `. This saved proposal predates that field: add a "rationale" string to your execution JSON, re-run apos lead propose --file <execution.json>, then apos lead commit ${id}`,
        );
        journal.append(newEvent(id, 'proposal-approved', { by: flags.by, proposalVersion: state.proposal.version }));
        if (state.proposal.mode === 'multi-wp') {
          const notice = {
            kind: 'multi-wp',
            goalId: id,
            packages: Object.keys(state.packages ?? {}),
            splitRationale: proposalRationale(state.proposal),
            estimatedCost: state.proposal.estimatedCost,
          };
          journal.append(newEvent(id, 'human-notified', notice));
          write(`NOTICE ${id}: Lead chose Multi-WP (${notice.packages.length} packages): ${notice.splitRationale}`);
        }
        write(`Accepted ${id}. Deliver with \`apos package submit ${id} <package> --commit <sha>\`.`);
      }),
    );
}
