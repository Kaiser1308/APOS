import { newEvent } from '../../app/events.js';
import { firstCommitTitle, fetchPullRequest } from '../../app/pull-request.js';
import { UserError } from '../../domain/errors.js';
import {
  MAINT_APPETITE,
  MAINT_APPROVE_VIA,
  maintenanceApprovalProblems,
  maintenanceGoalSpec,
  maintenanceSourceText,
  nextMaintenanceId,
  scanTools,
  type MaintenanceRequest,
} from '../../domain/maintenance.js';
import { approveInOneGo } from '../combined-approval.js';
import { ON_BEHALF_FLAGS, ON_BEHALF_HELP } from '../human-confirm.js';
import { resolveSecurity, scanBaseline } from '../maintenance-open.js';
import { pinnedSetupOf } from '../test-lock-wiring.js';
import type { CliContext } from '../context.js';

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** apos maintenance open | approve: a dependency upgrade or a security patch as one small Goal. The gates are the ordinary ones. */
export function registerMaintenance(ctx: CliContext): void {
  const { program, write, writeError, repo, withJournal, withJournalAsync } = ctx;
  const maintenance = program
    .command('maintenance')
    .description(
      'upgrade a dependency or patch a security finding with one small Goal: open it, the Human approves it',
    );

  maintenance
    .command('open')
    .argument(
      '[description]',
      'what is upgraded or patched, in a sentence (default with --from-pr: the title of its first commit)',
    )
    .option(
      '--security <finding>',
      'a finding of the base scan the delivery must remove: its fingerprint, or a ruleId one finding has (repeatable)',
      collect,
      [],
    )
    .option(
      '--paths <glob>',
      'a path the change may touch besides the manifests and lockfiles (repeatable)',
      collect,
      [],
    )
    .option('--part <part>', 'the part of the setup the change is in (default: every part)')
    .option('--from-pr <n>', 'the pull request the delivery comes from (a Dependabot PR): fetched with git, no gh')
    .option('--remote <name>', 'with --from-pr: the remote that has pull/<n>/head', 'origin')
    .description(
      'draft a Solo maintenance Goal: no criterion, the gate holds it to the base; then `apos maintenance approve <id>`',
    )
    .action(
      (
        description: string | undefined,
        flags: { security: string[]; paths: string[]; part?: string; fromPr?: string; remote: string },
      ) =>
        withJournal(journal => {
          const version = journal.setupHistory().approvals.at(-1)?.version;
          const setup = pinnedSetupOf(ctx, journal, version);
          if (!setup)
            throw new UserError(
              'maintenance needs an approved setup: the manifests and the scan come from it (`apos setup draft`, probe and approve one)',
            );
          if (flags.part && !setup.parts[flags.part])
            throw new UserError(`--part ${flags.part}: the setup has parts ${Object.keys(setup.parts).join(', ')}`);
          let fromPr: MaintenanceRequest['fromPr'];
          let text = description;
          if (flags.fromPr !== undefined) {
            const number = Number(flags.fromPr);
            if (!Number.isInteger(number) || number < 1) throw new UserError('--from-pr takes a pull request number');
            const sha = fetchPullRequest(repo(), flags.remote, number);
            fromPr = { number, remote: flags.remote, sha };
            text ??= firstCommitTitle(repo(), sha);
          }
          if (!text) throw new UserError('say what is upgraded or patched: a description, or --from-pr <n>');
          const id = nextMaintenanceId(journal.listGoals().map(item => item.spec.id));
          if (flags.security.length && !scanTools(setup, flags.part).length)
            throw new UserError(
              'the setup has no scan tool (a sarif tool in L5): a security Goal cannot show the finding gone. Add one to the setup and approve it, then open again',
            );
          const scanned = scanBaseline(ctx, journal, id, setup, flags.part);
          if (flags.security.length && scanned.problems.length)
            throw new UserError(
              `the base scan did not run, so the finding cannot be reproduced:\n- ${scanned.problems.join('\n- ')}`,
            );
          const security = flags.security.length ? resolveSecurity(flags.security, scanned.findings) : [];
          const request: MaintenanceRequest = {
            description: text,
            security,
            paths: flags.paths,
            ...(flags.part ? { part: flags.part } : {}),
            ...(fromPr ? { fromPr } : {}),
          };
          const spec = maintenanceGoalSpec({
            id,
            request,
            ...(scanned.baseline ? { baseline: scanned.baseline } : {}),
            now: new Date().toISOString(),
          });
          journal.appendWithSource(newEvent(id, 'goal-drafted', spec), maintenanceSourceText(request));
          write(`Drafted ${id} (maintenance)`);
          for (const problem of scanned.problems) writeError(`base scan: ${problem}`);
          write(`Next: the Human runs \`apos maintenance approve ${id}\``);
        }),
    );

  maintenance
    .command('approve')
    .argument('<id>')
    .option('--appetite <S|M|L>', 'size of the work', MAINT_APPETITE.size)
    .option('--minutes <n>', 'wall minutes from select to verified', String(MAINT_APPETITE.maxWallMinutes))
    .option('--attempts <n>', 'red gates one package may have', String(MAINT_APPETITE.maxAttempts))
    .option('--flag <name>', 'switch a setup tool on for this Goal (mutation, perf); repeatable', collect, [])
    .option(ON_BEHALF_FLAGS, ON_BEHALF_HELP)
    .description('Human: gate A, the appetite and gate B in one go (small, 60 minutes, 3 attempts unless said)')
    .action(
      (id: string, flags: { appetite: string; minutes: string; attempts: string; flag: string[]; onBehalf?: string }) =>
        withJournalAsync(async journal => {
          const { setupVersion, message } = await approveInOneGo(ctx, journal, {
            id,
            kind: 'maintenance',
            command: MAINT_APPROVE_VIA,
            appetite: {
              size: flags.appetite,
              maxWallMinutes: Number(flags.minutes),
              maxAttempts: Number(flags.attempts),
              overrun: MAINT_APPETITE.overrun,
            },
            flags: flags.flag,
            onBehalf: flags.onBehalf,
            problems: (state, version) => maintenanceApprovalProblems(state.spec, pinnedSetupOf(ctx, journal, version)),
          });
          write(message);
          write(`Next: the Lead plans it with \`apos lead propose --maintenance --goal ${id}\``);
          if (setupVersion === undefined) writeError('Goal không có setup: bảo đảm theo setup tắt');
        }),
    );
}
