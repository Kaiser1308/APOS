import { type BugCheck, bugCheckFromSetup, bugPart } from '../domain/bugfix.js';
import { UserError } from '../domain/errors.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';
import { pinnedSetupOf } from './test-lock-wiring.js';

/**
 * The part a bug lives in and the check it is delivered against, for `bug open` and `hotfix`: both come from the latest
 * approved setup, or from `--check` for a project that has none.
 */
export function bugCheckOf(
  ctx: CliContext,
  journal: ProjectJournal,
  flags: { part?: string; check?: string },
): { part: string | undefined; check: BugCheck } {
  const version = journal.setupHistory().approvals.at(-1)?.version;
  const setup = pinnedSetupOf(ctx, journal, version);
  if (setup) {
    if (flags.check)
      throw new UserError(
        '--check is for a project with no approved setup: here the check comes from the setup (change the setup to change it)',
      );
    const part = bugPart(setup, flags.part);
    return { part, check: bugCheckFromSetup(setup, part) };
  }
  if (!flags.check)
    throw new UserError(
      'this project has no approved setup: pass --check "<test command>" (or `apos setup draft`, probe and approve one)',
    );
  return { part: flags.part, check: { command: flags.check } };
}
