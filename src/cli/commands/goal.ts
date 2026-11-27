import { exitFor, jsonResult, verdictOf } from '../json-result.js';
import { Option, type Command } from 'commander';
import { UserError } from '../../domain/errors.js';
import { readFileSync } from 'node:fs';
import { newEvent } from '../../app/events.js';
import { parseAppetite } from '../../domain/contracts.js';
import { sourceDigest } from '../../domain/gate.js';
import { buildPlan } from '../../domain/plan.js';
import { GoalRegistryService } from '../../app/registry.js';
import { ON_BEHALF_FLAGS, ON_BEHALF_HELP } from '../human-confirm.js';
import { lockSummary } from '../lock-summary.js';
import { buildAssuranceReport, renderAssuranceText } from '../../domain/assurance-report.js';
import { hotfixRows, unprovenCount, unprovenLine } from '../../domain/hotfix.js';
import { pinnedSetupOf } from '../test-lock-wiring.js';
import { approvalSetupVersion, baselineMissingOf } from '../goal-approval.js';
import { maintenanceApprovalProblems } from '../../domain/maintenance.js';
import { refactorApprovalProblems } from '../legacy-plan.js';
import { removalApproval } from '../removal-approval.js';
import type { CliContext } from '../context.js';

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function registerGoal(ctx: CliContext): void {
  const { program, write, writeError, withJournal, withJournalAsync, assertHuman, goalWithSource } = ctx;
  const goal = program.command('goal');
  goal
    .command('create')
    .requiredOption('--file <json>')
    .requiredOption('--source <path>', 'verbatim source the Goal was shaped from')
    .option('--origin <text>', 'who or what produced the source', 'human')
    .option(
      '--kind <kind>',
      'feature (default), bugfix, characterize or refactor; the flag wins over "kind" in the file',
    )
    .option(
      '--covers <glob>',
      'characterize: code whose current behaviour this Goal captures (repeatable); the Human approves it with the Goal',
      collect,
      [],
    )
    .option(
      '--paths <glob>',
      'refactor: code to restructure (repeatable); each file must be covered by a closed characterize Goal',
      collect,
      [],
    )
    .action(
      ({
        file,
        source,
        origin,
        ...flags
      }: {
        file: string;
        source: string;
        origin: string;
        kind?: string;
        covers: string[];
        paths: string[];
      }) =>
        withJournal(journal => {
          const { spec, text } = goalWithSource(file, source, origin, flags);
          journal.appendWithSource(newEvent(spec.id, 'goal-drafted', spec), text);
          write(`Drafted ${spec.id}${spec.kind && spec.kind !== 'feature' ? ` (${spec.kind})` : ''}`);
        }),
    );
  goal.command('list').action(() =>
    withJournal(journal => {
      const goals = journal.listGoals();
      if (!goals.length) write('No Goals yet. Draft one with `apos goal create --file goal.json --source brief.md`.');
      for (const state of goals)
        write(
          `${state.spec.id}\t${state.status}\t${state.spec.outcome}\t${state.setupVersion === undefined ? 'không có setup' : `setup v${state.setupVersion}`}`,
        );
    }),
  );
  goal
    .command('show')
    .argument('<id>')
    .description('status, pinned setup, locked tests and the assurance table of one Goal')
    .option('--json', 'emit JSON')
    .action((id: string, flags: { json?: boolean }) =>
      withJournal(journal => {
        const state = journal.getGoal(id);
        if (!state) throw new UserError(`Goal not found: ${id}`);
        if (flags.json) {
          const verdict = state.gate ? verdictOf(state.gate.result) : 'unverifiable';
          process.exitCode = exitFor(verdict);
          write(
            JSON.stringify({
              ...jsonResult('goal show', state, verdict, state.gate),
              status: state.status,
            }),
          );
          return;
        }
        const unproven = unprovenCount(hotfixRows(journal.listGoals(), ctx.now()));
        if (unproven) write(unprovenLine(unproven));
        write(`${id}\t${state.status}\t${state.spec.outcome}`);
        write(state.setupVersion === undefined ? 'không có setup' : `setup v${state.setupVersion}`);
        for (const line of lockSummary(state)) write(line);
        // The pinned setup adds the stacks and the layers the close stage will run; the table reads without it when it cannot be loaded.
        let setup;
        try {
          setup = pinnedSetupOf(ctx, journal, state.setupVersion);
        } catch {
          setup = undefined;
        }
        write('');
        for (const line of renderAssuranceText(buildAssuranceReport(state, setup, ctx.now())).split('\n')) write(line);
      }),
    );
  // Gate A: the Human approves WHAT, together with the appetite only the controller will see.
  const appetiteOptions = <T extends Command>(command: T): T =>
    command
      .requiredOption('--size <S|M|L>')
      .requiredOption('--max-minutes <n>')
      .requiredOption('--max-attempts <n>')
      .option('--overrun <stop|ask>', 'what to do when a limit is hit', 'ask')
      .option(ON_BEHALF_FLAGS, ON_BEHALF_HELP)
      .addOption(new Option('--max-spend <usd>').hideHelp()) as T;
  type AppetiteFlags = {
    size: string;
    maxSpend?: string;
    maxMinutes: string;
    maxAttempts: string;
    overrun: string;
    onBehalf?: string;
  };
  const appetiteOf = (flags: AppetiteFlags) => {
    if (flags.maxSpend !== undefined)
      throw new UserError(
        '--max-spend no longer exists: APOS does not run agents, so it cannot measure spend. Bound the work with --max-minutes and --max-attempts',
      );
    return {
      size: flags.size,
      maxWallMinutes: Number(flags.maxMinutes),
      maxAttempts: Number(flags.maxAttempts),
      overrun: flags.overrun,
    };
  };
  appetiteOptions(goal.command('approve').argument('<id>'))
    .option('--setup-version <n|latest>', 'approved setup version to pin the Goal to', 'latest')
    .option('--flag <name>', 'switch a setup tool on for this Goal (mutation, perf); repeatable', collect, [])
    .action((id: string, flags: AppetiteFlags & { setupVersion: string; flag: string[] }) =>
      withJournalAsync(async journal => {
        const appetite = parseAppetite(appetiteOf(flags));
        const setupVersion = approvalSetupVersion(ctx, journal, id, flags.setupVersion, flags.flag);
        // A refactor is approved only on code a closed characterize Goal covers; looked at before anything is written.
        const state = journal.getGoal(id);
        const uncovered = state ? refactorApprovalProblems(ctx, journal, state) : [];
        if (uncovered.length) throw new UserError(`${id} cannot be approved:\n- ${uncovered.join('\n- ')}`);
        // Only a maintenance Goal reads the setup here: the others are approved as they always were.
        const unscanned =
          state?.spec.kind === 'maintenance'
            ? maintenanceApprovalProblems(state.spec, pinnedSetupOf(ctx, journal, setupVersion))
            : [];
        if (unscanned.length) throw new UserError(`${id} cannot be approved:\n- ${unscanned.join('\n- ')}`);
        // A Goal that removes tests shows which ones, found on the repo as it is now, before the Human confirms.
        const removal = state ? removalApproval(ctx, journal, state, setupVersion) : { problems: [], lines: [] };
        if (removal.problems.length)
          throw new UserError(`${id} cannot be approved:\n- ${removal.problems.join('\n- ')}`);
        if (removal.lines.length) {
          write(`${id} will remove these tests, and only these (the rest must stay):`);
          for (const line of removal.lines) write(line);
        }
        const confirmation = await assertHuman('goal approve', id, flags.onBehalf);
        new GoalRegistryService(journal).approve(
          id,
          appetite,
          undefined,
          confirmation,
          setupVersion,
          flags.flag,
          undefined,
          baselineMissingOf(journal, setupVersion),
        );
        write(
          `Approved ${id}${setupVersion === undefined ? '' : ` on setup v${setupVersion}`}${flags.flag.length ? ` with flag ${flags.flag.join(', ')}` : ''}`,
        );
        if (setupVersion === undefined)
          writeError(
            'Goal không có setup: bảo đảm theo setup tắt (approve một setup bằng apos setup approve rồi duyệt lại)',
          );
      }),
    );
  appetiteOptions(goal.command('appetite').argument('<id>'))
    .requiredOption('--reason <text>')
    .action((id: string, flags: AppetiteFlags & { reason: string }) =>
      withJournalAsync(async journal => {
        const appetite = parseAppetite(appetiteOf(flags));
        const confirmation = await assertHuman('goal appetite', id, flags.onBehalf);
        journal.append(
          newEvent(id, 'appetite-set', {
            appetite,
            reason: flags.reason,
            confirmation,
          }),
        );
        write(`Appetite for ${id} updated`);
      }),
    );
  // Gate B: the Human picks which approved Goal is worked next. Nothing is started; the Lead plans on its own.
  goal
    .command('select')
    .argument('<id>')
    .option(ON_BEHALF_FLAGS, ON_BEHALF_HELP)
    .action((id: string, flags: { onBehalf?: string }) =>
      withJournalAsync(async journal => {
        const confirmation = await assertHuman('goal select', id, flags.onBehalf);
        new GoalRegistryService(journal).select(id, confirmation);
        write(`Selected ${id}`);
      }),
    );
  goal
    .command('revise')
    .requiredOption('--file <json>')
    .requiredOption('--source <path>')
    .option('--origin <text>', 'who or what produced the source', 'human')
    .action(({ file, source, origin }: { file: string; source: string; origin: string }) =>
      withJournalAsync(async journal => {
        const { spec: revised, text } = goalWithSource(file, source, origin);
        const current = journal.getGoal(revised.id);
        if (!current || revised.version <= current.spec.version)
          throw new Error('Goal revision must advance the current version');
        journal.appendWithSource(newEvent(revised.id, 'goal-revised', revised), text);
        write(`Revised ${revised.id} v${revised.version}; Human approval required`);
      }),
    );
  program
    .command('plan')
    .description('show Goal plan and requirement coverage across the brief')
    .option('--source <path>', 'filter by source brief file')
    .option('--json', 'emit machine-readable JSON')
    .action((flags: { source?: string; json?: boolean }) =>
      withJournal(journal => {
        const sha = flags.source ? sourceDigest(readFileSync(flags.source, 'utf8')) : undefined;
        const plan = buildPlan(journal.listGoals(), sha);
        if (flags.json) {
          write(JSON.stringify(plan));
          return;
        }
        if (!plan.goals.length && !plan.requirements.length) {
          write('No Goals planned yet.');
          return;
        }
        for (const item of plan.goals)
          write(`goal\t${item.id}\t${item.status}${item.sketch ? ' (sketch)' : ''}\t${item.outcome}`);
        for (const req of plan.requirements) write(`req\t${req.id}\t${req.status}\t${req.goalId ?? '-'}\t${req.text}`);
      }),
    );
}
