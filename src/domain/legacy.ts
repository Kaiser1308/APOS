import { matchesAny, rootedGlobs } from './glob.js';
import { UserError } from './errors.js';
import { parseExecutionProposal, type ExecutionProposal, type GoalSpec } from './contracts.js';
import type { ProjectSetup } from './project-setup.js';
import type { TestLock } from './test-lock.js';
import { effectiveStatus, type GoalState } from './transitions.js';

/** A closed characterize Goal that holds locked tests: what a refactor may lean on. */
export type Characterization = { goalId: string; covers: string[]; lock: TestLock };

/** The closed characterize Goals of the repo that carry a lock, in Goal id order. */
export function characterizations(goals: GoalState[]): Characterization[] {
  return goals
    .filter(state => effectiveStatus(state) === 'closed' && state.spec.kind === 'characterize' && state.testLock)
    .map(state => ({ goalId: state.spec.id, covers: state.spec.covers ?? [], lock: state.testLock! }))
    .sort((a, b) => a.goalId.localeCompare(b.goalId));
}

export type Coverage = {
  /** Files of the repo that `paths` matches. */
  files: string[];
  /** Files no closed characterize Goal covers. */
  uncovered: string[];
  /** Globs of `paths` that match no file at all. */
  emptyGlobs: string[];
  /** The characterize Goals that cover at least one of the files: their locked tests are the refactor's evidence. */
  sources: Characterization[];
  /** Every closed characterize Goal considered, covering these files or not: they can have locked the same test file, whose newest version counts. */
  held: Characterization[];
};

/** Which of the files a refactor's `paths` reach are covered by a closed characterize Goal; each must match some `covers`. */
export function refactorCoverage(input: {
  paths: string[];
  files: string[];
  characterized: Characterization[];
}): Coverage {
  const matched = new Set<string>();
  const emptyGlobs: string[] = [];
  for (const glob of input.paths) {
    const hits = input.files.filter(file => matchesAny(file, [glob]));
    if (!hits.length) emptyGlobs.push(glob);
    for (const file of hits) matched.add(file);
  }
  const files = [...matched].sort();
  const uncovered = files.filter(file => !input.characterized.some(item => matchesAny(file, item.covers)));
  const sources = input.characterized.filter(item => files.some(file => matchesAny(file, item.covers)));
  return { files, uncovered, emptyGlobs, sources, held: input.characterized };
}

/** Why a refactor's `paths` are not all captured, as the refusal of `goal approve` and `lead commit`; empty when they are. */
export function coverageProblems(coverage: Coverage, at: string): string[] {
  const problems = coverage.emptyGlobs.map(
    glob => `paths "${glob}" matches no file at ${at}: a typo, or nothing there to refactor`,
  );
  if (coverage.uncovered.length)
    problems.push(
      `not covered by a closed characterize Goal: ${coverage.uncovered.join(', ')}. Capture their behaviour first (a characterize Goal whose covers include them, closed), or take them out of paths`,
    );
  return problems;
}

/**
 * The paths a refactor plan may name, from wherever the gate takes its scope (`paths` and `stubPaths` of the proposal and of
 * every package): each must be one of the Goal's own, or match only files the Goal's paths match (a plan cannot reach past
 * what the Human approved). A glob that matches no file is allowed only when it is the Goal's own.
 */
export function planPathProblems(input: {
  plan: { label: string; globs: string[] }[];
  goalPaths: string[];
  files: string[];
}): string[] {
  const problems: string[] = [];
  for (const { label, globs } of input.plan)
    for (const glob of globs) {
      if (input.goalPaths.includes(glob)) continue;
      const hits = input.files.filter(file => matchesAny(file, [glob]));
      const outside = hits.filter(file => !matchesAny(file, input.goalPaths));
      if (!hits.length) problems.push(`${label} "${glob}" matches no file and is not one of the Goal's paths`);
      else if (outside.length)
        problems.push(
          `${label} "${glob}" reaches past the Goal's paths (${input.goalPaths.join(', ')}): ${outside.join(', ')}`,
        );
    }
  return problems;
}

/**
 * The Solo plan of a characterize Goal: the Tester adds tests that are green on the code as it is and locks them; no
 * code is written. The package may change test files only (the part's `tests.paths`), so a delivery that touches code is
 * out of scope. The Lead submits the package on the commit that locked the tests.
 */
export function characterizeProposal(input: {
  goal: GoalSpec;
  version: number;
  baseCommit: string;
  setup?: ProjectSetup;
}): ExecutionProposal {
  const { goal, setup } = input;
  const paths = setup
    ? Object.values(setup.parts).flatMap(part => (part.tests ? rootedGlobs(part.root, part.tests.paths) : []))
    : [];
  if (setup && !paths.length)
    throw new UserError('the setup declares no tests.paths: a characterize Goal has nowhere to put its tests');
  return parseExecutionProposal({
    id: `EXEC-${goal.id.replace(/^GOAL-/, '')}`,
    version: input.version,
    goalId: goal.id,
    goalVersion: goal.version,
    mode: 'solo-direct',
    approach:
      'The Tester writes tests that describe what the covered code does today, odd behaviour included, and locks them while they are green. No code changes. The Lead then submits the package on the commit that locked them',
    rationale:
      'Capturing behaviour changes no code: one Tester commit with the tests, and the Lead submits that commit',
    risks: [
      'A test pins a defect as if it were wanted; the criterion says so, and a bug is opened later with apos bug',
    ],
    baseCommit: input.baseCommit,
    sourceSha256: goal.source.sha256,
    ...(paths.length ? { paths } : {}),
    acceptanceMapping: goal.acceptance.map(item => ({
      acceptanceId: item.id,
      verification: 'locked stays-green test: green on the code as it is, and on the delivery',
    })),
    verificationStrategy: 'the locked tests, then the Goal check and the layers of the stage',
  });
}

/** What the table says a refactor kept: set once a gate has judged the captured tests, `proven` only when it was green. */
export type Preserved = { proven: boolean; tests?: number; from?: string[]; base?: string; after?: string };

/**
 * For a refactor: the latest judgement of its captured tests, read from the gates the log holds (the close gate, else the
 * delivery gate). `proven` is true only when that gate found them green before and after.
 */
export function preservedEvidence(state: GoalState): Preserved | undefined {
  if (state.spec.kind !== 'refactor') return undefined;
  for (const gate of [state.closeGate, state.gate]) {
    const check = gate?.checks.find(item => item.checkId === 'APOS-CHARACTERIZED');
    if (!gate || !check) continue;
    if (check.status !== 'pass' || !check.preserved) return { proven: false };
    return {
      proven: true,
      tests: check.preserved.tests,
      from: check.preserved.from,
      base: gate.baseCommit.slice(0, 7),
      after: gate.deliveryCommit.slice(0, 7),
    };
  }
  return { proven: false };
}

/** For a characterize Goal: the code it captures and how many tests it has locked. */
export function capturedEvidence(state: GoalState): { covers: string[]; tests: number } | undefined {
  if (state.spec.kind !== 'characterize') return undefined;
  return {
    covers: state.spec.covers ?? [],
    tests: (state.testLock?.map ?? []).reduce((sum, entry) => sum + entry.testIds.length, 0),
  };
}
