import type { Acceptance, ExecutionProposal, GoalSpec } from './contracts.js';
import { globsOverlap } from './glob.js';
import type { WorkPackageSpec } from './packages.js';
import type { ProjectSetup } from './project-setup.js';

/** How a criterion is proved; Goals written before phase 3 carry none and mean `red-green`. */
export const acceptanceProof = (item: Acceptance): NonNullable<Acceptance['proof']> => item.proof ?? 'red-green';

/** The proofs the close stage gives (a tool and a threshold), and the Human's manual confirmation: none of them is a locked test. */
export const NON_TEST_PROOFS: readonly string[] = ['manual', 'benchmark', 'scan'];

/** Whether a criterion needs a locked test (`red-green`, `stays-green`) rather than a manual confirmation or a non-functional proof. */
export const needsTest = (item: Acceptance): boolean => !NON_TEST_PROOFS.includes(acceptanceProof(item));

/** Whether the Goal has any criterion a locked test must prove: only then is there a `testing` stage. */
export const goalNeedsTests = (goal: GoalSpec): boolean => goal.acceptance.some(needsTest);

/**
 * What `lead commit` checks about a plan beyond the older rules: every criterion that needs a test belongs to
 * exactly one package, packages that overlap share the common path on purpose, and a Goal pinned to a setup
 * says which files each package may change. Goals created before phase 3 pass `pinned: false` and keep the old rules.
 */
export function testPlanProblems(input: {
  goal: GoalSpec;
  proposal: ExecutionProposal;
  packages: WorkPackageSpec[];
  pinned: boolean;
}): string[] {
  const { goal, proposal, packages, pinned } = input;
  const problems: string[] = [];
  if (proposal.mode !== 'multi-wp') {
    if (pinned && !proposal.paths?.length)
      problems.push('proposal.paths is required: the gate needs to know which files the package may change');
    return problems;
  }
  for (const item of goal.acceptance.filter(needsTest)) {
    const owners = packages
      .filter(pkg => pkg.acceptance.some(criterion => criterion.goalAcceptanceId === item.id))
      .map(pkg => pkg.id);
    if (owners.length !== 1)
      problems.push(
        `${item.id} belongs to ${owners.length ? `${owners.length} packages (${owners.join(', ')})` : 'no package'}: a criterion that needs a test belongs to exactly one`,
      );
  }
  if (!pinned) return problems;
  for (const pkg of packages)
    if (!pkg.paths?.length)
      problems.push(`${pkg.id} has no paths: the gate needs to know which files the package may change`);
  const shared = new Set(proposal.sharedPaths);
  for (const [index, first] of packages.entries())
    for (const second of packages.slice(index + 1))
      for (const a of first.paths ?? [])
        for (const b of second.paths ?? []) {
          if (!globsOverlap(a, b)) continue;
          // The narrower glob is the path they share.
          const common = b.length >= a.length ? b : a;
          if (!shared.has(a) && !shared.has(b) && !shared.has(common))
            problems.push(
              `${first.id} and ${second.id} both claim ${common}: list it in sharedPaths or split the paths`,
            );
        }
  return problems;
}

/** Whether a setup says where tests are for at least one part: without it nothing can be locked. */
export const setupLocksTests = (setup: ProjectSetup): boolean => Object.values(setup.parts).some(part => part.tests);
