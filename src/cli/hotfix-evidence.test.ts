import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evidenceProject, removeTemp, temp } from './hotfix.test-support.js';

const saved = { home: process.env.APOS_HOME, now: process.env.APOS_NOW };
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-hotfix-ev-home-');
  process.env.APOS_NOW = '2026-11-24T08:00:00.000Z';
});
afterEach(() => {
  process.exitCode = undefined;
  for (const [key, value] of [
    ['APOS_HOME', saved.home],
    ['APOS_NOW', saved.now],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  removeTemp();
});

const planned = async () => {
  const p = await evidenceProject();
  await p.accept();
  await p.invoke('lead', 'propose', '--bugfix', '--goal', p.goalId);
  await p.invoke('lead', 'commit', p.goalId);
  return p;
};

describe('the plan of a hotfix Goal', () => {
  it('starts from the commit before the hotfix and may change what the hotfix changed', async () => {
    const p = await evidenceProject();
    await p.accept();
    await p.invoke('lead', 'propose', '--bugfix', '--goal', p.goalId);
    expect(p.state(p.goalId)!.proposal).toMatchObject({
      baseCommit: p.before,
      paths: ['src/impl.txt'],
      stubPaths: ['src/impl.txt'],
    });
  });
  it('is refused a base other than the commit before the hotfix, by --base and by a plan file', async () => {
    const p = await evidenceProject();
    await p.accept();
    await expect(p.invoke('lead', 'propose', '--bugfix', '--goal', p.goalId, '--base', p.hotfix)).rejects.toThrow(
      /hotfix.*starts from/,
    );
  });
});

describe('the evidence of a hotfix', () => {
  it('refuses a test that is green on the commit before the hotfix, and locks one that is red there', async () => {
    const p = await planned();
    const green = p.tests('pass');
    expect(await p.invoke('tests', 'submit', p.goalId, '--commit', green).then(() => process.exitCode)).toBe(1);
    expect(p.out.join('\n')).toContain('không tái hiện lỗi');
    expect(p.state(p.goalId)!.testLock).toBeUndefined();
    process.exitCode = undefined;
    const red = p.tests('needs total');
    await p.invoke('tests', 'submit', p.goalId, '--commit', red);
    expect(p.state(p.goalId)!.testLock?.commit).toBe(red);
  }, 120_000);

  it('goes green only on a delivery that contains the hotfix commit, and then the Goal closes and the hotfix is proven', async () => {
    const p = await planned();
    const red = p.tests('needs total');
    await p.invoke('tests', 'submit', p.goalId, '--commit', red);
    // A delivery that does the fix itself instead of containing the hotfix commit.
    p.git('checkout', '-q', '--detach', red);
    const own = p.commit({ 'src/impl.txt': 'total\n' }, 'my own fix');
    await p.invoke('package', 'submit', p.goalId, 'WP-MAIN', '--commit', own);
    expect(process.exitCode).toBe(1);
    expect(p.out.join('\n')).toMatch(/APOS-HOTFIX fail: .*does not contain the hotfix commit/);
    process.exitCode = undefined;
    // The delivery: the Tester's commit with the hotfix merged in.
    p.git('checkout', '-q', '--detach', red);
    p.git('merge', '-q', '--no-edit', p.hotfix);
    const delivery = p.git('rev-parse', 'HEAD');
    p.out.length = 0;
    await p.invoke('package', 'submit', p.goalId, 'WP-MAIN', '--commit', delivery);
    expect(process.exitCode ?? 0).toBe(0);
    expect(p.state(p.goalId)!.status).toBe('verified');
    await p.invoke('outcome', 'close', p.goalId, '--on-behalf', 'demo');
    expect(p.state(p.goalId)!.status).toBe('closed');
    p.out.length = 0;
    await p.invoke('hotfix', 'list');
    expect(p.out.join('\n')).toContain('có bằng chứng');
    expect(p.out.join('\n')).toContain('hotfix chưa có bằng chứng: 0');
    p.out.length = 0;
    await p.invoke('inbox');
    expect(p.out.join('\n')).not.toContain('hotfix');
    p.out.length = 0;
    await p.invoke('goal', 'show', p.goalId);
    const table = p.out.join('\n');
    expect(table).not.toContain('hotfix chưa có bằng chứng:');
    expect(table).toContain(
      `đỏ trên ${p.before.slice(0, 7)}, xanh trên ${p.hotfix.slice(0, 7)} (bản giao ${delivery.slice(0, 7)} chứa hotfix)`,
    );
  }, 240_000);

  it('is red when the delivery changes code outside what the hotfix changed', async () => {
    const p = await planned();
    const red = p.tests('needs total');
    await p.invoke('tests', 'submit', p.goalId, '--commit', red);
    p.git('checkout', '-q', '--detach', red);
    p.git('merge', '-q', '--no-edit', p.hotfix);
    const extra = p.commit({ 'src/other.txt': 'sneaked in\n' }, 'more code');
    await p.invoke('package', 'submit', p.goalId, 'WP-MAIN', '--commit', extra);
    expect(process.exitCode).toBe(1);
    expect(p.out.join('\n')).toMatch(/APOS-SCOPE fail: .*src\/other\.txt/);
  }, 240_000);
});
