import { newEvent } from '../../app/events.js';
import { runHotfixLayers } from '../../app/hotfix-gate.js';
import { BUG_APPETITE, bugPart, nextBugId } from '../../domain/bugfix.js';
import { UserError } from '../../domain/errors.js';
import {
  DEFAULT_DUE,
  HOTFIX_APPROVE_VIA,
  STATUS_WORD,
  dueAtOf,
  dueMs,
  hotfixGoalDraft,
  hotfixRows,
  redNote,
  short,
  unprovenCount,
  unprovenLine,
  type HotfixLayerResult,
} from '../../domain/hotfix.js';
import type { ProjectSetup } from '../../domain/project-setup.js';
import type { ProjectJournal } from '../../store/journal.js';
import { withGateLease } from '../../store/lease.js';
import { bugCheckOf } from '../bug-check.js';
import { approveInOneGo } from '../combined-approval.js';
import { hotfixRange } from '../hotfix-commit.js';
import { ON_BEHALF_FLAGS, ON_BEHALF_HELP } from '../human-confirm.js';
import { pinnedSetupOf, runnerFor } from '../test-lock-wiring.js';
import type { CliContext } from '../context.js';

type Flags = {
  commit?: string;
  before?: string;
  due: string;
  given?: string;
  when?: string;
  then?: string;
  part?: string;
  reproHint?: string;
  check?: string;
  onBehalf?: string;
};

/**
 * apos hotfix: the Human lets a fix through now and APOS remembers. It writes `hotfix-accepted`, opens the bugfix Goal that
 * will prove the fix (red on the commit before it, green on it), and records what L0 and L1 say on the hotfix commit
 * without holding anything up. APOS merges nothing: the Human merges the commit.
 */
export function registerHotfix(ctx: CliContext): void {
  const { program, write, writeError, repo, withJournal, withJournalAsync } = ctx;
  const hotfix = program
    .command('hotfix')
    .description(
      'Human: let a fix through now without waiting for the gate; APOS records it, opens the bugfix Goal that owes the evidence, and flags it when overdue',
    );

  hotfix
    .argument('[description]', 'what is on fire, in a sentence')
    .option('--commit <sha>', 'the full sha of the hotfix commit the Human merges now')
    .option(
      '--before <sha>',
      'the commit before the hotfix, where the bug must be reproduced (default: its only parent; required for a merge or root commit)',
    )
    .option('--due <duration>', 'when the evidence is due: 90m, 24h, 2d', DEFAULT_DUE)
    .option('--given <text>', 'the situation the bug shows in (with --when and --then the Goal is approved at once)')
    .option('--when <text>', 'what is done')
    .option('--then <text>', 'what should happen')
    .option('--part <part>', 'the part of the setup the bug lives in (needed when the setup has several)')
    .option('--repro-hint <path>', 'where the bug shows (a path); a hint for the Tester and the plan')
    .option('--check <command>', 'the test command, only for a project with no approved setup')
    .option(ON_BEHALF_FLAGS, ON_BEHALF_HELP)
    .action((description: string | undefined, flags: Flags) =>
      withJournalAsync(async journal => {
        if (!description?.trim())
          throw new UserError('say what is on fire: apos hotfix "<description>" --commit <sha>');
        if (!flags.commit) throw new UserError('--commit <sha> is required: the hotfix commit the Human merges');
        if (dueMs(flags.due) === undefined)
          throw new UserError(`--due ${flags.due}: a number with its unit, such as 90m, 24h or 2d`);
        const said = [flags.given, flags.when, flags.then].filter(item => item !== undefined).length;
        if (said !== 0 && said !== 3)
          throw new UserError('--given, --when and --then come together: the one criterion the evidence proves');
        const range = hotfixRange(repo(), flags.commit, flags.before);
        const twin = journal.listGoals().find(item => item.spec.hotfixOf?.commit === range.commit);
        if (twin) throw new UserError(`hotfix ${range.commit} is already accepted: ${twin.spec.id}`);
        const setup = pinnedSetupOf(ctx, journal, journal.setupHistory().approvals.at(-1)?.version);
        const full = said === 3;
        const placed = full
          ? bugCheckOf(ctx, journal, flags)
          : { part: setup && flags.part ? bugPart(setup, flags.part) : flags.part, check: undefined };
        // Everything that could refuse has been looked at; only now is the Human asked, and nothing is written before the answer.
        const confirmation = await ctx.assertHuman('hotfix', short(range.commit), flags.onBehalf);
        const acceptedAt = ctx.now();
        const id = nextBugId(journal.listGoals().map(item => item.spec.id));
        const link = {
          commit: range.commit,
          before: range.before,
          due: flags.due,
          dueAt: dueAtOf(acceptedAt, flags.due)!,
        };
        const { spec, text } = hotfixGoalDraft({
          id,
          description,
          link,
          now: new Date().toISOString(),
          ...(full
            ? { report: { given: flags.given!, when: flags.when!, then: flags.then! }, check: placed.check }
            : {}),
          ...(placed.part ? { part: placed.part } : {}),
          ...(flags.reproHint ? { reproHint: flags.reproHint } : {}),
        });
        const { layers, note } = await layersOn(journal, setup, range.commit, range.changed, id);
        journal.appendWithSource(newEvent(id, 'goal-drafted', spec), text);
        journal.append(
          newEvent(id, 'hotfix-accepted', {
            commit: range.commit,
            before: range.before,
            description,
            due: flags.due,
            dueAt: link.dueAt,
            acceptedAt,
            by: confirmation.by,
            ...(confirmation.onBehalf ? { onBehalf: confirmation.onBehalf } : {}),
            confirmation,
          }),
        );
        journal.append(newEvent(id, 'hotfix-gated', { commit: range.commit, layers, ...(note ? { note } : {}) }));

        write(
          `Hotfix ${short(range.commit)} accepted: merge it now (APOS merges nothing). Goal ${id} (bugfix) owes the evidence.`,
        );
        write(`Evidence due: ${link.dueAt} (${flags.due}); the bug is reproduced on ${short(range.before)}`);
        const state = journal.getGoal(id)!;
        const red = redNote({ ...state.hotfix!, layers });
        for (const item of layers)
          write(
            `  hotfix ${item.part}.${item.layer} ${item.tool}: ${item.status}${item.note ? ` (${item.note})` : ''}`,
          );
        if (note) write(`  ${note}`);
        if (red) write(`  ${red}`);

        if (!full) {
          write(
            `Next: the PM adds the one criterion with \`apos goal revise\` (version 2), keeping this in the Goal as it is, then the Human runs \`apos bug approve ${id}\``,
          );
          write(`  "hotfixOf": ${JSON.stringify(link)}`);
          return;
        }
        try {
          const { message } = await approveInOneGo(ctx, journal, {
            id,
            kind: 'bugfix',
            command: HOTFIX_APPROVE_VIA,
            appetite: { ...BUG_APPETITE },
            flags: [],
            confirmed: confirmation,
          });
          write(`${message} (duyệt gộp bằng hotfix)`);
          write(`Next: the Lead plans it with \`apos lead propose --bugfix --goal ${id}\``);
        } catch (error) {
          if (!(error instanceof UserError)) throw error;
          writeError(`${id} was not approved: ${error.message}`);
          write(`Next: the Human fixes that, then runs \`apos bug approve ${id}\``);
        }
      }),
    );

  /** L0 and L1 on the hotfix commit, under the gate lease; whatever goes wrong here is a note, never a refusal. */
  async function layersOn(
    journal: ProjectJournal,
    setup: ProjectSetup | undefined,
    commit: string,
    changed: string[],
    goalId: string,
  ): Promise<{ layers: HotfixLayerResult[]; note?: string }> {
    if (!setup) return { layers: [], note: 'no approved setup: L0 and L1 did not run on the hotfix' };
    try {
      const runner = runnerFor(ctx, journal, goalId, 'hotfix');
      const held = await withGateLease(ctx.home(), () =>
        Promise.resolve(runHotfixLayers({ runner, setup, commit, changed })),
      );
      if (!held.ran)
        return {
          layers: [],
          note: `another gate is running (pid ${held.holder}): L0 and L1 did not run on the hotfix`,
        };
      return {
        layers: held.value,
        ...(held.value.length ? {} : { note: 'the setup has no L0 or L1 tool for the parts the hotfix touched' }),
      };
    } catch (error) {
      return { layers: [], note: `L0 and L1 could not run on the hotfix: ${(error as Error).message}` };
    }
  }

  hotfix
    .command('list')
    .description('every hotfix: has evidence, waiting, overdue or abandoned, its deadline and its Goal')
    .action(() =>
      withJournal(journal => {
        const rows = hotfixRows(journal.listGoals(), ctx.now());
        if (!rows.length) {
          write('No hotfix yet.');
          return;
        }
        for (const { goal, hotfix: item, status } of rows)
          write(
            `${goal.spec.id}\t${STATUS_WORD[status]}\t${short(item.commit)}\thạn ${item.dueAt}\t${item.description}${redNote(item) ? `\t${redNote(item)}` : ''}`,
          );
        write(unprovenLine(unprovenCount(rows)));
      }),
    );
}
