import { newEvent } from '../../app/events.js';
import { GoalRegistryService } from '../../app/registry.js';
import {
  BUG_APPETITE,
  BUG_APPROVE_VIA,
  type BugCheck,
  bugCheckFromSetup,
  bugGoalSpec,
  bugPart,
  bugSourceText,
  nextBugId,
} from '../../domain/bugfix.js';
import { goalApprovalBlockers, goalKind, parseAppetite } from '../../domain/contracts.js';
import { UserError } from '../../domain/errors.js';
import { ON_BEHALF_FLAGS, ON_BEHALF_HELP } from '../human-confirm.js';
import { approvalSetupVersion } from '../goal-approval.js';
import { pinnedSetupOf } from '../test-lock-wiring.js';
import type { CliContext } from '../context.js';

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** apos bug open | approve: fixing a bug as one small Goal. The gates are the ordinary ones; only creating and approving are shorter. */
export function registerBug(ctx: CliContext): void {
  const { program, write, writeError, withJournal, withJournalAsync, assertHuman } = ctx;
  const bug = program.command('bug').description('fix a bug with one small Goal: open it, the Human approves it');

  bug
    .command('open')
    .argument('<description>', 'what is wrong, in a sentence')
    .requiredOption('--given <text>', 'the situation the bug shows in')
    .requiredOption('--when <text>', 'what is done')
    .requiredOption('--then <text>', 'what should happen')
    .option('--repro-hint <path>', 'where the bug shows (a path); a hint for the Tester and the plan, no gate reads it')
    .option('--part <part>', 'the part of the setup the bug lives in (needed when the setup has several)')
    .option('--check <command>', 'the test command, only for a project with no approved setup')
    .description('draft a Solo bugfix Goal: one criterion, a red-green test; then `apos bug approve <id>`')
    .action(
      (
        description: string,
        flags: { given: string; when: string; then: string; reproHint?: string; part?: string; check?: string },
      ) =>
        withJournal(journal => {
          const version = journal.setupHistory().approvals.at(-1)?.version;
          const setup = pinnedSetupOf(ctx, journal, version);
          let part = flags.part;
          let check: BugCheck;
          if (setup) {
            if (flags.check)
              throw new UserError(
                '--check is for a project with no approved setup: here the check comes from the setup (change the setup to change it)',
              );
            part = bugPart(setup, flags.part);
            check = bugCheckFromSetup(setup, part);
          } else {
            if (!flags.check)
              throw new UserError(
                'this project has no approved setup: pass --check "<test command>" (or `apos setup draft`, probe and approve one)',
              );
            check = { command: flags.check };
          }
          const report = {
            description,
            given: flags.given,
            when: flags.when,
            then: flags.then,
            ...(flags.reproHint ? { reproHint: flags.reproHint } : {}),
            ...(part ? { part } : {}),
          };
          const id = nextBugId(journal.listGoals().map(item => item.spec.id));
          const spec = bugGoalSpec({ id, report, check, now: new Date().toISOString() });
          journal.appendWithSource(newEvent(id, 'goal-drafted', spec), bugSourceText(report));
          write(`Drafted ${id} (bugfix)`);
          write(`Next: the Human runs \`apos bug approve ${id}\``);
        }),
    );

  bug
    .command('approve')
    .argument('<id>')
    .option('--appetite <S|M|L>', 'size of the work', BUG_APPETITE.size)
    .option('--minutes <n>', 'wall minutes from select to verified', String(BUG_APPETITE.maxWallMinutes))
    .option('--attempts <n>', 'red gates one package may have', String(BUG_APPETITE.maxAttempts))
    .option('--flag <name>', 'switch a setup tool on for this Goal (mutation, perf); repeatable', collect, [])
    .option(ON_BEHALF_FLAGS, ON_BEHALF_HELP)
    .description('Human: gate A, the appetite and gate B in one go (small, 60 minutes, 3 attempts unless said)')
    .action(
      (id: string, flags: { appetite: string; minutes: string; attempts: string; flag: string[]; onBehalf?: string }) =>
        withJournalAsync(async journal => {
          const appetite = parseAppetite({
            size: flags.appetite,
            maxWallMinutes: Number(flags.minutes),
            maxAttempts: Number(flags.attempts),
            overrun: BUG_APPETITE.overrun,
          });
          const state = journal.getGoal(id);
          if (!state) throw new UserError(`Goal not found: ${id}`);
          if (goalKind(state.spec) !== 'bugfix')
            throw new UserError(
              `${id} is not a bugfix Goal: approve it with \`apos goal approve ${id}\` and \`apos goal select ${id}\``,
            );
          if (state.status !== 'draft')
            throw new UserError(`${id} is ${state.status}: bug approve is for a Goal still in draft`);
          const blockers = goalApprovalBlockers(state.spec);
          if (blockers.length) throw new UserError(`${id} cannot be approved:\n- ${blockers.join('\n- ')}`);
          const registry = new GoalRegistryService(journal);
          // Everything that could refuse is looked at before the first event: a refusal leaves the log as it was.
          const pending = registry.selectProblems(id);
          if (pending.length) throw new UserError(`${id} cannot be selected yet: ${pending.join('; ')}`);
          const setupVersion = approvalSetupVersion(ctx, journal, id, 'latest', flags.flag);
          const confirmation = await assertHuman('bug approve', id, flags.onBehalf);
          registry.approve(id, appetite, undefined, confirmation, setupVersion, flags.flag, BUG_APPROVE_VIA);
          journal.append(
            newEvent(id, 'appetite-set', {
              appetite,
              reason: `${BUG_APPROVE_VIA}: the default appetite for a bug`,
              confirmation,
              via: BUG_APPROVE_VIA,
            }),
          );
          registry.select(id, confirmation, BUG_APPROVE_VIA);
          write(
            `Approved and selected ${id}${setupVersion === undefined ? '' : ` on setup v${setupVersion}`} (${appetite.size}, ${appetite.maxWallMinutes} min, ${appetite.maxAttempts} attempts)`,
          );
          write(`Next: the Lead plans it with \`apos lead propose --bugfix --goal ${id}\``);
          if (setupVersion === undefined) writeError('Goal không có setup: bảo đảm theo setup tắt');
        }),
    );
}
