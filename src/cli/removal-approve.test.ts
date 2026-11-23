import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTemp, temp } from './bug.test-support.js';
import { removalCli } from './removal.test-support.js';

const saved = process.env.APOS_HOME;
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-removal-home-');
});
afterEach(() => {
  process.exitCode = undefined;
  if (saved === undefined) delete process.env.APOS_HOME;
  else process.env.APOS_HOME = saved;
  removeTemp();
});

describe('apos goal approve of a Goal that removes tests', () => {
  it('prints the tests that will go, found on the repo as it is, then approves', async () => {
    const p = await removalCli();
    await p.approve();
    const said = p.out.join('\n');
    expect(said).toContain('GOAL-001 will remove these tests, and only these');
    expect(said).toContain('AC-1: 2 test(s)');
    expect(said).toContain('- app.L1::tests.unit.old::a');
    expect(said).toContain('- app.L1::tests.unit.old::b');
    expect(said).not.toContain('keep');
    expect(p.state('GOAL-001')?.status).toBe('approved');
  }, 60_000);

  it('refuses a declared test the base does not have, and lists every one (Review Focus 3)', async () => {
    const p = await removalCli(['app.L1::tests.unit.old::zzz', 'app.L1::tests.unit.ghost', 'web.L1::tests.x']);
    await expect(p.approve()).rejects.toThrow(/GOAL-001 cannot be approved/);
    const said = (await p.approve().catch((error: Error) => error.message)) as string;
    expect(said).toContain('app.L1::tests.unit.old::zzz: no such test on the base');
    expect(said).toContain('app.L1::tests.unit.ghost: no such test on the base');
    expect(said).toContain('web.L1::tests.x: the base has no test run for web.L1');
    expect(p.state('GOAL-001')?.status).toBe('draft');
  }, 60_000);

  it('refuses a Goal that removes tests when the project has no approved setup', async () => {
    const p = await removalCli(undefined, { setup: false });
    await expect(p.approve()).rejects.toThrow(/removes tests.*approve a setup first/);
    expect(p.state('GOAL-001')?.status).toBe('draft');
  }, 60_000);
});
