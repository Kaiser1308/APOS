import { UserError } from '../domain/errors.js';
import { FLAG_PATTERN, MUTATION_FLAG } from '../domain/goal-flags.js';
import { proofToolProblems } from '../domain/proof-tools.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';
import { pinnedSetupOf } from './test-lock-wiring.js';

/**
 * The checks `goal approve` and `bug approve` share, run before anything is written: which approved setup the Goal is
 * pinned to (`latest` or a version), that the flags are words, that a mutation flag has a tool, and that the tools the
 * criteria name exist in that setup. Returns the setup version, undefined when the project has no approved setup.
 */
export function approvalSetupVersion(
  ctx: CliContext,
  journal: ProjectJournal,
  id: string,
  requested: string,
  flagList: string[],
): number | undefined {
  const approvals = journal.setupHistory().approvals;
  let setupVersion: number | undefined;
  if (requested === 'latest') setupVersion = approvals.at(-1)?.version;
  else {
    setupVersion = Number(requested);
    if (!approvals.some(item => item.version === setupVersion))
      throw new UserError(
        `Setup version ${requested} was never approved (approved: ${approvals.map(item => item.version).join(', ') || 'none'})`,
      );
  }
  for (const flag of flagList)
    if (!FLAG_PATTERN.test(flag)) throw new UserError(`--flag ${flag}: a flag is a word (letters, digits, - and _)`);
  // Mutation needs a tool: a flag that switches nothing on would look like a guarantee that is not there.
  if (flagList.includes(MUTATION_FLAG)) {
    const setup = pinnedSetupOf(ctx, journal, setupVersion);
    const has = Object.values(setup?.parts ?? {}).some(part =>
      Object.values(part.layers).some(tools => tools?.some(tool => tool.when === `flag:${MUTATION_FLAG}`)),
    );
    if (!has)
      throw new UserError(
        `${id} cannot be approved with --flag ${MUTATION_FLAG}: the setup has no tool that says \`when: flag:${MUTATION_FLAG}\`. Add one to the setup (see docs/catalog.md, Mutation), approve it, then approve the Goal again`,
      );
  }
  // A benchmark or scan criterion names a tool of the setup the Goal is pinned to: approving one the setup lacks proves nothing.
  const goalSpec = journal.getGoal(id)?.spec;
  if (goalSpec?.acceptance.some(item => item.benchmark || item.scan)) {
    const setup = pinnedSetupOf(ctx, journal, setupVersion);
    const problems = setup
      ? proofToolProblems(goalSpec, setup)
      : [`${id} has benchmark or scan criteria but there is no approved setup to take their tools from`];
    if (problems.length) throw new UserError(`${id} cannot be approved:\n- ${problems.join('\n- ')}`);
  }
  return setupVersion;
}
