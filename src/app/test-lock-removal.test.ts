import { afterEach, describe, expect, it } from 'vitest';
import { setupDocument, testingProject, cleanProjects } from './test-lock.test-support.js';
import { absenceTests, baseFiles, removalGoal } from './removal.test-support.js';

afterEach(cleanProjects);

/** The Tester's test of absence is held to the rule of a red test: it must fail while the feature is there, for the right reason. */
describe('locking the test of absence of a removed feature', () => {
  const submit = async (kind: string) => {
    const p = await testingProject({ goal: removalGoal(), setup: setupDocument, files: baseFiles });
    return p.service.submit(p.goalId, p.commit(absenceTests(p.goalId, kind), 'the test'), 'tester');
  };

  it('locks a test that fails on an assertion while the feature is there', async () => {
    expect(await submit('gone coupon')).toMatchObject({ ok: true });
  }, 60_000);

  it('refuses a test that is already green: the feature is gone already, or the test never asks', async () => {
    const result = await submit('pass');
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.problems.join('\n')).toMatch(/already green: the feature is gone already/);
  }, 60_000);

  it('refuses a test that is red because the code it imports is not there (Review Focus 4)', async () => {
    const load = await submit('load');
    expect(load.ok ? '' : load.problems.join('\n')).toMatch(/the test did not load/);
    const typo = await submit('typo');
    expect(typo.ok ? '' : typo.problems.join('\n')).toMatch(/must fail on an assertion while it is still there/);
  }, 120_000);

  it('refuses an error that says "not implemented": there is no stub of a feature to remove', async () => {
    const result = await submit('needs-err stub');
    expect(result.ok ? '' : result.problems.join('\n')).toMatch(/must fail on an assertion/);
  }, 60_000);

  it('refuses a Tester commit that changes anything but tests: the feature must be there, as it is', async () => {
    const p = await testingProject({ goal: removalGoal(), setup: setupDocument, files: baseFiles });
    const stubbed = p.commit({ ...absenceTests(p.goalId), 'src/stub.txt': 'stub\n' }, 'a stub too');
    const result = await p.service.submit(p.goalId, stubbed, 'tester');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problems.join('\n')).toMatch(/src\/stub.txt: removal: the Tester adds tests only/);
    expect(p.state().testLock).toBeUndefined();
  }, 60_000);
});
