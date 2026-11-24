import { afterEach, describe, expect, it } from 'vitest';
import { cleanProjects } from './test-lock.test-support.js';
import { parseGoalSpec } from '../domain/contracts.js';
import type { GoalState, PackageState } from '../domain/transitions.js';
import { spec } from '../domain/fixtures.test-support.js';
import { NO_COUPON, OLD, lockedBy, removalGoal, removalProject } from './removal.test-support.js';

afterEach(cleanProjects);

const gone = { 'tests/unit/old.t': null, 'src/impl.txt': '' };

describe('a delivery that removes a feature', () => {
  it('is green when exactly the declared tests are gone and the test of absence passes', async () => {
    const p = await removalProject();
    const result = await p.submit(p.commit(gone, 'remove the coupon'));
    expect(result.result).toBe('green');
    expect(p.inventory()).toMatchObject({ status: 'pass', removal: { tests: [`${OLD}::a`, `${OLD}::b`] } });
  }, 60_000);

  it('is red, naming the test, when one more test than declared is gone (Review Focus 1)', async () => {
    const p = await removalProject();
    const result = await p.submit(p.commit({ ...gone, 'tests/unit/keep.t': 'case d pass\n' }, 'too much'));
    expect(result.result).toBe('red');
    expect(p.inventory()).toMatchObject({ status: 'fail', reason: 'test missing: app.L1::tests.unit.keep::c' });
  }, 60_000);

  it('is red when a declared test is still there (Review Focus 2), by file or by id', async () => {
    const p = await removalProject({ goal: removalGoal([`${OLD}::a`, `${OLD}::b`]) });
    const result = await p.submit(p.commit({ ...gone, 'tests/unit/old.t': 'case b pass\n' }, 'forgot one'));
    expect(result.result).toBe('red');
    expect(p.inventory()?.reason).toBe(`declared removed but still there: ${OLD}::b`);
  }, 60_000);

  it('is red while the test of absence is red, however many old tests went', async () => {
    const p = await removalProject();
    const result = await p.submit(p.commit({ 'tests/unit/old.t': null }, 'tests gone, feature not'));
    expect(result.result).toBe('red');
    expect(p.check('APOS-LOCKED')?.reason).toContain(NO_COUPON);
  }, 60_000);

  it('is red for a Goal that declares nothing: it may not lose a test (the old rule stands)', async () => {
    const p = await removalProject({ goal: removalGoal([`${OLD}::a`]) });
    const result = await p.submit(p.commit(gone, 'b went too'));
    expect(result.result).toBe('red');
    expect(p.inventory()?.reason).toBe(`test missing: ${OLD}::b`);
  }, 60_000);

  describe('when the old tests are the locked tests of another Goal (Review Focus 5)', () => {
    const FLOW = 'app.L2::tests.acceptance.oldflow';
    const files = { 'tests/acceptance/oldflow.t': 'case applies pass\n' };
    const paths = ['src/**', 'tests/unit/**', 'tests/acceptance/oldflow.t'];
    const others = [lockedBy('GOAL-OLD', ['tests.acceptance.oldflow::applies'])];
    const delivery = { ...gone, 'tests/acceptance/oldflow.t': null };

    it('lets them go when declared, and the table says whose they were', async () => {
      const p = await removalProject({ goal: removalGoal([OLD, FLOW]), files, others, paths });
      const result = await p.submit(p.commit(delivery, 'remove it all'));
      expect(result.result).toBe('green');
      expect(p.inventory()?.removal?.locked).toEqual([{ goalId: 'GOAL-OLD', tests: [`${FLOW}::applies`] }]);
    }, 60_000);

    it('does not let them go when only the other tests are declared', async () => {
      const p = await removalProject({ goal: removalGoal([OLD]), files, others, paths });
      const result = await p.submit(p.commit(delivery, 'one file too many'));
      expect(result.result).toBe('red');
      expect(p.inventory()?.reason).toBe(`test missing: ${FLOW}::applies`);
    }, 60_000);

    it('finds a declared test in a layer the floor does not run (L2 is not in the package floor)', async () => {
      const p = await removalProject({ goal: removalGoal([FLOW]), files, others, paths });
      const result = await p.submit(p.commit({ 'src/impl.txt': '' }, 'forgot to delete the file'));
      expect(result.result).toBe('red');
      expect(p.inventory()?.reason).toBe(`declared removed but still there: ${FLOW}::applies`);
    }, 60_000);
  });

  describe.each(['integrate', 'close'] as const)('at the %s stage (Review Focus 6)', stage => {
    const inventoryAt = async (p: Awaited<ReturnType<typeof removalProject>>, head: string) =>
      p.assurance
        .layerChecks(p.state(), { stage, scope: p.goalId, head, base: p.lockCommit, changed: [] })
        .checks.find(check => check.checkId === 'APOS-INVENTORY');

    it('holds the whole Goal to the same list: the declared tests may go, no other', async () => {
      const p = await removalProject();
      const good = await inventoryAt(p, p.commit(gone, 'remove the coupon'));
      expect(good).toMatchObject({ status: 'pass', removal: { tests: [`${OLD}::a`, `${OLD}::b`] } });
      const extra = await inventoryAt(p, p.commit({ 'tests/unit/keep.t': 'case d pass\n' }, 'one more'));
      expect(extra).toMatchObject({ status: 'fail', reason: 'test missing: app.L1::tests.unit.keep::c' });
    }, 60_000);

    it('is red when a declared test is still there', async () => {
      const p = await removalProject();
      const late = await inventoryAt(p, p.commit({ 'tests/unit/old.t': 'case b pass\n' }, 'forgot'));
      expect(late).toMatchObject({ status: 'fail', reason: `declared removed but still there: ${OLD}::b` });
    }, 60_000);
  });
});

describe('a Multi-WP package that builds on a package which already removed tests (Codex)', () => {
  const KEEP = 'app.L1::tests.unit.keep';
  const goal = parseGoalSpec({
    ...spec,
    acceptance: [
      { ...spec.acceptance[0]!, id: 'AC-1', proof: 'removed', removesTests: [OLD] },
      { ...spec.acceptance[0]!, id: 'AC-2', proof: 'removed', removesTests: [KEEP] },
    ],
    checks: [{ ...spec.checks[0]!, command: 'node -e "process.exit(0)"' }],
  });
  const packageOf = (id: string, criterion: string, dependencies: string[], extra: Partial<PackageState> = {}) =>
    ({
      spec: {
        id,
        goalId: goal.id,
        goalVersion: 1,
        version: 1,
        owner: 'w',
        outcome: id,
        scope: ['x'],
        exclusions: [],
        dependencies,
        interfaces: ['x@v1'],
        acceptance: [{ id: 'WA-1', text: 'x', goalAcceptanceId: criterion }],
        integration: 'x',
      },
      status: 'pending',
      attempts: 0,
      ...extra,
    }) as PackageState;
  const setup = async () => {
    const p = await removalProject({
      goal,
      tests: {
        'tests/acceptance/nocoupon.t': 'case absent gone coupon\n',
        'tests/acceptance/nokeep.t': 'case absent gone coupon\n',
        '.apos/goals/GOAL-001/tests.json': JSON.stringify([
          { acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [NO_COUPON] },
          { acceptanceId: 'AC-2', part: 'app', layer: 'L2', testIds: ['tests.acceptance.nokeep::absent'] },
        ]),
      },
    });
    const removedA = p.commit({ 'tests/unit/old.t': null, 'src/impl.txt': '' }, 'WP-A removes the old coupon tests');
    const removedB = p.commit({ 'tests/unit/keep.t': null }, 'WP-B removes the keep tests');
    const green = packageOf('WP-A', 'AC-1', [], { status: 'green', gate: { deliveryCommit: removedA } as never });
    const withPackages = (packages: Record<string, PackageState>): GoalState => ({ ...p.state(), packages });
    const inventory = (state: GoalState, id: string, head: string) =>
      p.assurance.checks(state, state.packages![id]!, head, p.lockCommit, []).find(c => c.checkId === 'APOS-INVENTORY');
    return { p, green, removedA, removedB, withPackages, inventory };
  };

  it('does not call the tests its green dependency removed lost', async () => {
    const { green, removedB, withPackages, inventory } = await setup();
    const state = withPackages({ 'WP-A': green, 'WP-B': packageOf('WP-B', 'AC-2', ['WP-A']) });
    expect(inventory(state, 'WP-B', removedB)).toMatchObject({ status: 'pass' });
  }, 60_000);

  it('still calls them lost for a package that does not build on that dependency', async () => {
    const { green, removedB, withPackages, inventory } = await setup();
    const state = withPackages({ 'WP-A': green, 'WP-C': packageOf('WP-C', 'AC-2', []) });
    expect(inventory(state, 'WP-C', removedB)).toMatchObject({ status: 'fail' });
    expect(inventory(state, 'WP-C', removedB)?.reason).toContain(`test missing: ${OLD}::a`);
  }, 60_000);
});
