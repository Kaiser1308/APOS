import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { newEvent } from '../../app/events.js';
import { parseAppetite } from '../../domain/contracts.js';
import { sourceDigest } from '../../domain/gate.js';
import { buildPlan } from '../../domain/plan.js';
import { GoalRegistryService } from '../../app/registry.js';
import { ON_BEHALF_FLAGS, ON_BEHALF_HELP } from '../human-confirm.js';
import type { CliContext } from '../context.js';

export function registerGoal(ctx: CliContext): void {
  const { program, write, withJournal, withJournalAsync, assertHuman, goalWithSource } = ctx;
  const goal = program.command('goal');
  goal
    .command('create')
    .requiredOption('--file <json>')
    .requiredOption('--source <path>', 'verbatim source the Goal was shaped from')
    .option('--origin <text>', 'who or what produced the source', 'human')
    .action(({ file, source, origin }: { file: string; source: string; origin: string }) =>
      withJournal(journal => {
        const { spec, text } = goalWithSource(file, source, origin);
        journal.appendWithSource(newEvent(spec.id, 'goal-drafted', spec), text);
        write(`Drafted ${spec.id}`);
      }),
    );
  goal.command('list').action(() =>
    withJournal(journal => {
      const goals = journal.listGoals();
      if (!goals.length) write('No Goals yet. Draft one with `apos goal create --file goal.json --source brief.md`.');
      for (const state of goals) write(`${state.spec.id}\t${state.status}\t${state.spec.outcome}`);
    }),
  );
  // Gate A: the Human approves WHAT, together with the appetite only the controller will see.
  const appetiteOptions = <T extends Command>(command: T): T =>
    command
      .requiredOption('--size <S|M|L>')
      .requiredOption('--max-spend <usd>')
      .requiredOption('--max-minutes <n>')
      .requiredOption('--max-attempts <n>')
      .option('--overrun <stop|ask>', 'what to do when a limit is hit', 'ask')
      .option(ON_BEHALF_FLAGS, ON_BEHALF_HELP) as T;
  type AppetiteFlags = {
    size: string;
    maxSpend: string;
    maxMinutes: string;
    maxAttempts: string;
    overrun: string;
    onBehalf?: string;
  };
  const appetiteOf = (flags: AppetiteFlags) => ({
    size: flags.size,
    maxSpendUsd: Number(flags.maxSpend),
    maxWallMinutes: Number(flags.maxMinutes),
    maxAttempts: Number(flags.maxAttempts),
    overrunPolicy: flags.overrun,
  });
  appetiteOptions(goal.command('approve').argument('<id>')).action((id: string, flags: AppetiteFlags) =>
    withJournalAsync(async journal => {
      const confirmation = await assertHuman('goal approve', id, flags.onBehalf);
      new GoalRegistryService(journal).approve(id, parseAppetite(appetiteOf(flags)), undefined, confirmation);
      write(`Approved ${id}`);
    }),
  );
  appetiteOptions(goal.command('appetite').argument('<id>'))
    .requiredOption('--reason <text>')
    .action((id: string, flags: AppetiteFlags & { reason: string }) =>
      withJournalAsync(async journal => {
        const confirmation = await assertHuman('goal appetite', id, flags.onBehalf);
        journal.append(
          newEvent(id, 'appetite-set', {
            appetite: parseAppetite(appetiteOf(flags)),
            reason: flags.reason,
            confirmation,
          }),
        );
        write(`Appetite for ${id} updated`);
      }),
    );
  // Gate B: the Human picks which approved Goal is worked next. Nothing is dispatched; the Lead plans on its own.
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
