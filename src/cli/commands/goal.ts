import type { Command } from 'commander';
import { newEvent } from '../../app/events.js';
import { parseAppetite } from '../../domain/contracts.js';
import { LeadService } from '../../app/lead.js';
import { assertExecutionSettled } from '../../app/replan.js';
import { GoalRegistryService } from '../../app/registry.js';
import { describeProfiles } from '../../runtime/brief.js';
import type { CliContext } from '../context.js';

export function registerGoal(ctx: CliContext): void {
  const { program, write, runtime, repo, home, withJournal, withJournalAsync, assertHuman, goalWithSource } = ctx;
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
      .option('--overrun <stop|ask>', 'what to do when a limit is hit', 'ask') as T;
  type AppetiteFlags = { size: string; maxSpend: string; maxMinutes: string; maxAttempts: string; overrun: string };
  const appetiteOf = (flags: AppetiteFlags) => ({
    size: flags.size,
    maxSpendUsd: Number(flags.maxSpend),
    maxWallMinutes: Number(flags.maxMinutes),
    maxAttempts: Number(flags.maxAttempts),
    overrunPolicy: flags.overrun,
  });
  appetiteOptions(goal.command('approve').argument('<id>')).action((id: string, flags: AppetiteFlags) =>
    withJournal(journal => {
      assertHuman(journal, 'goal approve');
      new GoalRegistryService(journal).approve(id, parseAppetite(appetiteOf(flags)));
      write(`Approved ${id}`);
    }),
  );
  appetiteOptions(goal.command('appetite').argument('<id>'))
    .requiredOption('--reason <text>')
    .action((id: string, flags: AppetiteFlags & { reason: string }) =>
      withJournal(journal => {
        assertHuman(journal, 'goal appetite');
        journal.append(
          newEvent(id, 'appetite-set', { appetite: parseAppetite(appetiteOf(flags)), reason: flags.reason }),
        );
        write(`Appetite for ${id} updated`);
      }),
    );
  // Gate B. Selecting a Goal dispatches its Lead, which plans and, in Solo, delivers in the same session.
  goal
    .command('select')
    .argument('<id>')
    .action((id: string) =>
      withJournalAsync(async journal => {
        assertHuman(journal, 'goal select');
        new GoalRegistryService(journal).select(id);
        write(`Selected ${id}`);
        const lead = describeProfiles(home()).lead;
        write(
          `Lead runs on ${lead.agent}${lead.model ? ` model=${lead.model}` : ''}${lead.effort ? ` effort=${lead.effort}` : ''} (${lead.source}); change it first with \`apos profile set lead --agent <id> --model <id>\`, or move a running Lead with \`apos handoff ${id}\`.`,
        );
        try {
          write(`Dispatched Lead ${id}: ${(await new LeadService(journal, runtime).start(id, repo())).dispatchId}`);
        } catch (error) {
          write(
            `Lead not dispatched for ${id}: ${error instanceof Error ? error.message : String(error)}. Retry with \`apos lead start ${id}\`.`,
          );
        }
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
        await assertExecutionSettled(current, runtime, { includeLead: true });
        journal.appendWithSource(newEvent(revised.id, 'goal-revised', revised), text);
        write(`Revised ${revised.id} v${revised.version}; Human approval required`);
      }),
    );
}
