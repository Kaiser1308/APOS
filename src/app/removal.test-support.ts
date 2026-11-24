import type { GoalState } from '../domain/transitions.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { parseGoalSpec, type GoalSpec } from '../domain/contracts.js';
import { spec } from '../domain/fixtures.test-support.js';
import { AssuranceService } from './assurance-service.js';
import { GateService } from './gate-service.js';
import { GitCommitInspector } from './integration.js';
import { PackageService } from './package-service.js';
import { setupDocument, testingProject } from './test-lock.test-support.js';

/** The feature that goes away is `coupon`: `src/impl.txt` says it is there; the old tests of it are tests/unit/old.t. */
export const OLD = 'app.L1::tests.unit.old';
export const NO_COUPON = 'tests.acceptance.nocoupon::absent';
export const baseFiles = {
  'src/impl.txt': 'coupon\n',
  'tests/unit/old.t': 'case a pass\ncase b pass\n',
  'tests/unit/keep.t': 'case c pass\ncase d pass\n',
};

/** A feature Goal with one `removed` criterion that declares `removesTests`. */
export const removalGoal = (removesTests: string[] = [OLD], extra: Partial<GoalSpec> = {}): GoalSpec =>
  parseGoalSpec({
    ...spec,
    acceptance: [{ ...spec.acceptance[0]!, text: 'coupons are gone', proof: 'removed', removesTests }],
    checks: [{ ...spec.checks[0]!, command: 'node -e "process.exit(0)"' }],
    ...extra,
  });

/** The Tester's commit: one test of absence, red while the coupon is still in `src/impl.txt`. */
export const absenceTests = (goalId: string, kind = 'gone coupon'): Record<string, string> => ({
  'tests/acceptance/nocoupon.t': `case absent ${kind}\n`,
  [`.apos/goals/${goalId}/tests.json`]: JSON.stringify([
    { acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [NO_COUPON] },
  ]),
});

/** A project with a removal Goal whose absence test is locked, ready for a worker commit to be gated. */
export async function removalProject(
  options: {
    goal?: GoalSpec;
    setup?: object;
    files?: Record<string, string>;
    others?: GoalState[];
    paths?: string[];
    /** The Tester's commit, when one test of absence is not enough (a Goal with several removed criteria). */
    tests?: Record<string, string>;
  } = {},
) {
  const goal = options.goal ?? removalGoal();
  const p = await testingProject({
    goal,
    setup: options.setup ?? setupDocument,
    files: { ...baseFiles, ...options.files },
    ...(options.paths ? { paths: options.paths } : {}),
  });
  const lockCommit = p.commit(options.tests ?? absenceTests(p.goalId), 'the test of absence');
  const locked = await p.service.submit(p.goalId, lockCommit, 'tester');
  if (!locked.ok) throw new Error(`fixture tests were refused: ${locked.problems.join('; ')}`);
  const goals = () => [...p.journal.listGoals(), ...(options.others ?? [])];
  const assurance = new AssuranceService({
    repo: p.dir,
    runner: p.runner,
    inspector: new GitCommitInspector(),
    loadSetup: p.loadSetup,
    goals,
  });
  const gate = new GateService(p.journal, { artifactRoot: p.artifacts, assurance });
  const packages = new PackageService(p.journal, { gate, repoPath: p.dir });
  const submit = (commit: string) => packages.submit(p.goalId, 'WP-MAIN', commit, 'worker');
  const check = (id: string) => {
    const state = p.state();
    return (state.gate ?? state.packages?.['WP-MAIN']?.gate)?.checks.find(item => item.checkId === id);
  };
  const inventory = () => check('APOS-INVENTORY');
  return { ...p, lockCommit, assurance, gate, packages, submit, inventory, check, jsonCodec };
}

/** A closed Goal of the project that locked acceptance tests (`<part>.<layer>` is `app.L2`), as the log would show it. */
export const lockedBy = (id: string, testIds: string[]): GoalState => ({
  spec: { ...spec, id },
  status: 'closed',
  selected: true,
  evidence: [],
  reviews: [],
  testLock: {
    commit: 'e'.repeat(40),
    files: {},
    asserts: {},
    map: [{ acceptanceId: 'AC-9', part: 'app', layer: 'L2' as const, testIds }],
    by: 't',
  },
});
