import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTemp, temp } from './bug.test-support.js';
import { maintProject, manifest } from './maintenance.test-support.js';

const saved = process.env.APOS_HOME;
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-pr-home-');
});
afterEach(() => {
  process.exitCode = undefined;
  if (saved === undefined) delete process.env.APOS_HOME;
  else process.env.APOS_HOME = saved;
  removeTemp();
});

/** A project, and a second repo standing for the remote, with a pull request made by hand: a commit under `refs/pull/<n>/head`. */
async function withPullRequest(parent: 'base' | 'older') {
  const p = await maintProject();
  const remote = temp('apos-remote-');
  execFileSync('git', ['clone', '-q', p.dir, remote]);
  const rgit = (...args: string[]) =>
    execFileSync('git', ['-C', remote, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', ...args], {
      encoding: 'utf8',
    }).trim();
  const base = p.head();
  const onto = parent === 'base' ? base : rgit('rev-parse', 'HEAD~1');
  rgit('checkout', '-q', '--detach', onto);
  writeFileSync(join(remote, 'deps.json'), manifest({ fmt: '1.1.0' }));
  rgit('add', '-A');
  rgit('commit', '-qm', 'Bump fmt from 1.0.0 to 1.1.0');
  const pr = rgit('rev-parse', 'HEAD');
  rgit('update-ref', 'refs/pull/1/head', pr);
  p.git('remote', 'add', 'origin', remote);
  return { p, remote, rgit, base, pr };
}

describe('apos maintenance open --from-pr', () => {
  it('fetches pull/<n>/head, records the number and the sha, and takes the description from the first commit', async () => {
    const { p, pr } = await withPullRequest('base');
    await p.invoke('maintenance', 'open', '--from-pr', '1');
    const goal = p.state('GOAL-MAINT-001')!;
    expect(goal.spec.fromPr).toEqual({ number: 1, remote: 'origin', sha: pr });
    expect(goal.spec.outcome).toBe('Bump fmt from 1.0.0 to 1.1.0');
    expect(p.git('rev-parse', '--verify', 'refs/apos/pr/1')).toBe(pr);
  });

  it('keeps a description that is given, and says when the pull request is not on the remote', async () => {
    const { p } = await withPullRequest('base');
    await p.invoke('maintenance', 'open', 'My own words', '--from-pr', '1');
    expect(p.state('GOAL-MAINT-001')!.spec.outcome).toBe('My own words');
    await expect(p.invoke('maintenance', 'open', '--from-pr', '7')).rejects.toThrow(/cannot fetch pull request #7/);
  });
});

describe('apos package submit --from-pr', () => {
  const plan = async (p: Awaited<ReturnType<typeof maintProject>>, base: string) => {
    await p.invoke('maintenance', 'open', '--from-pr', '1');
    await p.invoke('maintenance', 'approve', 'GOAL-MAINT-001', '--on-behalf', 'item 1');
    await p.invoke('lead', 'propose', '--maintenance', '--goal', 'GOAL-MAINT-001', '--base', base);
    await p.invoke('lead', 'commit', 'GOAL-MAINT-001');
    p.out.length = 0;
  };

  it('gates the recorded sha, green, and the table says where the change came from', async () => {
    const { p, base, pr } = await withPullRequest('base');
    await plan(p, base);
    await p.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN', '--from-pr');
    expect(process.exitCode ?? 0).toBe(0);
    expect(p.state('GOAL-MAINT-001')!.status).toBe('verified');
    p.out.length = 0;
    await p.invoke('goal', 'show', 'GOAL-MAINT-001');
    expect(p.out.join('\n')).toContain(`từ PR #1 ${pr.slice(0, 7)}`);
  });

  it('refuses when the remote moved the pull request, and asks for --commit', async () => {
    const { p, remote, rgit, base } = await withPullRequest('base');
    await plan(p, base);
    writeFileSync(join(remote, 'deps.json'), manifest({ fmt: '1.2.0' }));
    rgit('commit', '-qam', 'force pushed');
    rgit('update-ref', 'refs/pull/1/head', rgit('rev-parse', 'HEAD'));
    await expect(p.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN', '--from-pr')).rejects.toThrow(
      /now points at .* pass --commit/,
    );
    expect(p.state('GOAL-MAINT-001')!.packages?.['WP-MAIN']?.status).toBe('pending');
  });

  it('refuses a pull request that does not contain the base of the Goal: rebase it', async () => {
    const { p, base } = await withPullRequest('older');
    await plan(p, base);
    await expect(p.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN', '--from-pr')).rejects.toThrow(
      /does not contain the base .*rebase the change onto it/,
    );
  });

  it('needs exactly one of --commit and --from-pr, and a Goal opened from a pull request', async () => {
    const { p, base } = await withPullRequest('base');
    await plan(p, base);
    await expect(p.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN')).rejects.toThrow(/exactly one of/);
    await expect(
      p.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN', '--from-pr', '--commit', 'a'.repeat(40)),
    ).rejects.toThrow(/exactly one of/);
    const plain = await maintProject();
    await plain.invoke('maintenance', 'open', 'x');
    await expect(plain.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN', '--from-pr')).rejects.toThrow(
      /not opened with/,
    );
  });
});
