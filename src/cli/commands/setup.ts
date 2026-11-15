import { initProject } from '../../app/init-project.js';
import { describeProfiles, resetProfile } from '../../runtime/brief.js';
import type { CliContext } from '../context.js';

export function registerSetup(ctx: CliContext): void {
  const { program, write, repo, home, withJournal, assertHuman, rolesOf, applyProfile } = ctx;
  program
    .command('init')
    .description('initialize .apos in a Git project')
    .option(
      '--skills <dir>',
      'folder with apos-core/ and apos-<role>/ skills (default: APOS_SKILLS, else the copy bundled with APOS)',
    )
    .action(async (flags: { skills?: string }) => {
      await initProject(repo(), flags.skills);
      write(`Initialized ${repo()}`);
    });
  program
    .command('migrate')
    .description('import APOS v1 Goal histories from the repo into the controller log')
    .action(() =>
      withJournal(journal => {
        write(JSON.stringify(journal.importLegacy()));
      }),
    );
  const profile = program
    .command('profile')
    .description('which agent, model and effort each role runs with (<controller home>/runtime.json)');
  profile.command('show').action(() => {
    for (const [role, item] of Object.entries(describeProfiles(home())))
      write(
        `${role}: ${item.agent}${item.model ? ` model=${item.model}` : ''}${item.effort ? ` effort=${item.effort}` : ''} (${item.source})`,
      );
  });
  profile
    .command('set')
    .argument('<role>', 'lead, worker, reviewer or all')
    .requiredOption('--agent <id>', 'Orca agent id: codex, claude, antigravity, ...')
    .option('--model <id>')
    .option('--effort <level>', 'needs --model')
    .description('Human: change the agent of a role; the next dispatch of that role uses it')
    .action((role: string, flags: { agent: string; model?: string; effort?: string }) =>
      withJournal(journal => {
        assertHuman(journal, 'profile set');
        applyProfile(rolesOf(role), flags);
      }),
    );
  profile
    .command('reset')
    .argument('[role]', 'lead, worker, reviewer or all', 'all')
    .description('Human: back to the default profile')
    .action((role: string) =>
      withJournal(journal => {
        assertHuman(journal, 'profile reset');
        resetProfile(home(), rolesOf(role));
      }),
    );
}
