import { afterEach, describe, expect, it } from 'vitest';
import { cleanProjects } from './test-lock.test-support.js';
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
