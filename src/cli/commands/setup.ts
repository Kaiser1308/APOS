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
    .action(async (flags: { skills?: string }) => {
      await initProject(repo(), flags.skills, options.codec);
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
