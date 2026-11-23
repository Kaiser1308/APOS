import { initProject } from '../../app/init-project.js';
import type { CliContext } from '../context.js';

export function registerSetup(ctx: CliContext): void {
  const { program, options, write, repo, withJournal } = ctx;
  program
    .command('init')
    .description('initialize .apos in a Git project')
    .option(
      '--skills <dir>',
      'folder with apos-core/ and apos-<role>/ skills (default: APOS_SKILLS, else the copy bundled with APOS)',
    )
    .option('--no-agents-md', 'do not write the APOS block into AGENTS.md or point CLAUDE.md at it')
    .action(async (flags: { skills?: string; agentsMd?: boolean }) => {
      await initProject(repo(), flags.skills, options.codec, { agentsMd: flags.agentsMd });
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
}
