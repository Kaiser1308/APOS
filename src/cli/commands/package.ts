import { exitFor, jsonResult, verdictOf } from '../json-result.js';
import { UserError } from '../../domain/errors.js';
import { commitToSubmit } from '../submit-commit.js';
import { withGateLease } from '../../store/lease.js';
import { GateService } from '../../app/gate-service.js';
import { PackageService } from '../../app/package-service.js';
import { parseWorkPackage } from '../../domain/packages.js';
import { assuranceService, pinnedSetupOf } from '../test-lock-wiring.js';
import { ExceptionService } from '../../app/exceptions.js';
import { ON_BEHALF_FLAGS, ON_BEHALF_HELP } from '../human-confirm.js';
import type { CliContext } from '../context.js';

export function registerPackage(ctx: CliContext): void {
  const { program, options, write, repo, withJournalAsync, withJournal, readJsonFile, assertHuman } = ctx;
  const packages = program.command('package').description('the Lead plans packages; delivery goes through `submit`');
  packages
    .command('add')
    .requiredOption('--file <json>')
    .requiredOption('--reason <text>')
    .option('--by <name>', 'who plans, for the log', 'lead')
    .action(({ file, reason, by }: { file: string; reason: string; by: string }) =>
      withJournal(journal => {
        const spec = parseWorkPackage(readJsonFile(file));
        new PackageService(journal).add(spec.goalId, spec, reason, by);
        write(`Drafted ${spec.id}`);
      }),
    );
  packages
    .command('remove')
    .argument('<goalId>')
    .argument('<packageId>')
    .requiredOption('--reason <text>')
    .option('--by <name>', 'who plans, for the log', 'lead')
    .action((goalId: string, packageId: string, { reason, by }: { reason: string; by: string }) =>
      withJournal(journal => {
        new PackageService(journal).remove(goalId, packageId, reason, by);
        write(`Removed ${packageId}`);
      }),
    );
  packages
    .command('revise')
    .argument('<goalId>')
    .requiredOption('--file <json>')
    .requiredOption('--reason <text>')
    .option('--by <name>', 'who plans, for the log', 'lead')
    .action((goalId: string, { file, reason, by }: { file: string; reason: string; by: string }) =>
      withJournal(journal => {
        const spec = new PackageService(journal).revise(goalId, readJsonFile(file), reason, by);
        write(`Revised ${spec.id} v${spec.version}`);
      }),
    );
  packages
    .command('submit')
    .argument('<goalId>')
    .argument('<packageId>', 'WP-MAIN for a Solo plan')
    .option('--commit <sha>', 'the full sha of the commit to gate')
    .option(
      '--from-pr',
      'maintenance Goal opened with --from-pr: gate the sha recorded when it was opened, fetched again from the remote',
    )
    .option('--by <name>', 'who submits, for the log', 'lead')
    .option('--json', 'print the result as JSON')
    .description('Lead: gate this commit now; exits 0 green, 1 red, 3 needs a Human or could not be verified')
    .action(
      (goalId: string, packageId: string, flags: { commit?: string; fromPr?: boolean; by: string; json?: boolean }) =>
        withJournalAsync(async journal => {
          const commit = commitToSubmit(repo(), journal.getGoal(goalId), flags);
          const gate = new GateService(journal, {
            inspector: options.inspector,
            ...options.gate,
            assurance: assuranceService(ctx, journal, goalId),
          });
          const service = new PackageService(journal, { gate, repoPath: repo(), inspector: options.inspector });
          const held = await withGateLease(ctx.home(), () => service.submit(goalId, packageId, commit, flags.by));
          if (!held.ran)
            throw new UserError(
              `Another gate is running for this project (pid ${held.holder}): wait for it, then submit again`,
            );
          const outcome = held.value;
          const state = journal.getGoal(goalId);
          process.exitCode = exitFor(verdictOf(outcome.result));
          if (flags.json) {
            write(
              JSON.stringify({
                ...jsonResult('package submit', state, verdictOf(outcome.result), state?.packages?.[packageId]?.gate),
                goalId,
                packageId,
                commit,
                ...outcome,
                goalStatus: state?.status,
              }),
            );
            return;
          }
          write(
            `${packageId} ${outcome.result} on ${commit}${outcome.result === 'green' && state?.status === 'verified' ? `; ${goalId} verified` : ''}`,
          );
          for (const reason of outcome.reasons) write(`  ${reason}`);
          for (const warning of outcome.warnings) write(`  ${warning}`);
          if (state?.status === 'blocked') write(`${goalId} is blocked: ${state.blocker?.note}`);
        }),
    );
  const exception = program
    .command('exception')
    .description('approve what the gate cannot decide: a sensitive file changed, or locked tests weakened');
  exception
    .command('approve')
    .argument('<goalId>')
    .requiredOption('--kind <kind>', 'needs-human | tests-weakened | tests-infra | floor-reduced')
    .requiredOption(
      '--ref <ref>',
      'the package id (needs-human, tests-infra), the revision commit (tests-weakened), <package>:<stage>:<layer> (floor-reduced; <goal>:<stage>:<layer> for integrate and close)',
    )
    .requiredOption('--reason <text>', 'why; the log keeps it')
    .option('--by <agent:name>', 'an agent approves for the Human (spec 7.3); logged as agent:<name>')
    .option('--human', 'the Human approves: confirmed in a terminal or with --on-behalf')
    .option(ON_BEHALF_FLAGS, ON_BEHALF_HELP)
    .action(
      (
        goalId: string,
        flags: { kind: string; ref: string; reason: string; by?: string; human?: boolean; onBehalf?: string },
      ) =>
        withJournalAsync(async journal => {
          if (Boolean(flags.by) === Boolean(flags.human))
            throw new UserError('Give exactly one of --by agent:<name> or --human');
          const confirmation = flags.human
            ? await assertHuman('exception approve', flags.ref, flags.onBehalf)
            : undefined;
          const done = new ExceptionService(journal, state => pinnedSetupOf(ctx, journal, state.setupVersion)).approve(
            goalId,
            {
              kind: flags.kind,
              ref: flags.ref,
              reason: flags.reason,
              by: flags.human ? 'human' : flags.by!,
              confirmation,
            },
          );
          write(
            `Approved ${done.kind} for ${done.ref} on ${done.commit} by ${flags.human ? 'the Human' : flags.by}. ${done.kind === 'needs-human' || done.kind === 'tests-infra' ? `Submit ${done.ref} again with the same commit.` : done.kind === 'floor-reduced' ? 'It counts for every gate that runs from now on.' : 'Submit the revision again.'}`,
          );
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
}
