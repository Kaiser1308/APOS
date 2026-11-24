import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProgram } from '../cli-app.js';
import { hotfixArgs, hotfixProject, removeTemp, temp } from './hotfix.test-support.js';

const saved = { home: process.env.APOS_HOME, now: process.env.APOS_NOW };
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-hotfix-home-');
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

describe('apos hotfix command shape', () => {
  it('has the hotfix itself and `hotfix list`', () => {
    const program = buildProgram();
    const hotfix = program.commands.find(item => item.name() === 'hotfix')!;
    expect(hotfix.commands.map(item => item.name())).toEqual(['list']);
    expect(hotfix.options.map(item => item.long)).toEqual(
      expect.arrayContaining(['--commit', '--before', '--due', '--given', '--when', '--then', '--part', '--on-behalf']),
    );
  });
});

describe('apos hotfix', () => {
  it('is a Human command: an agent with no terminal and no --on-behalf is refused and nothing is written', async () => {
    const p = await hotfixProject();
    await expect(p.invoke('hotfix', 'checkout is on fire', '--commit', p.hotfix, ...hotfixArgs)).rejects.toThrow(
      /Human decision/,
    );
    expect(p.open(journal => journal.listGoals())).toHaveLength(0);
  });

  it('with a Given/When/Then records the hotfix, approves and selects the Goal in one confirmation, and runs L1 on the commit', async () => {
    const p = await hotfixProject();
    await p.invoke('hotfix', 'checkout is on fire', '--commit', p.hotfix, ...hotfixArgs, '--on-behalf', 'demo');
    const goal = p.state('GOAL-BUG-001')!;
    expect(goal.status).toBe('selected');
    expect(goal.spec.hotfixOf).toMatchObject({ commit: p.hotfix, before: p.before, due: '24h' });
    expect(goal.hotfix).toMatchObject({
      commit: p.hotfix,
      before: p.before,
      by: 'on-behalf',
      onBehalf: 'demo',
      dueAt: '2026-11-25T08:00:00.000Z',
    });
    expect(goal.hotfix?.layers).toEqual([expect.objectContaining({ part: 'app', layer: 'L1', status: 'pass' })]);
    expect(goal.bugApproval).toMatchObject({ by: 'on-behalf', via: 'hotfix' });
    const out = p.out.join('\n');
    expect(out).toContain('2026-11-25T08:00:00.000Z');
    expect(out).toContain('apos lead propose --bugfix --goal GOAL-BUG-001');
    expect(out).toContain('duyệt gộp bằng hotfix');
    const types = p.events('GOAL-BUG-001').map(item => item.type);
    expect(types).toEqual([
      'goal-drafted',
      'hotfix-accepted',
      'hotfix-gated',
      'goal-approved',
      'documents-published',
      'appetite-set',
      'goal-selected',
    ]);
  });

  it('without a criterion leaves the Goal waiting as a sketch for the PM, and still records the hotfix', async () => {
    const p = await hotfixProject();
    await p.invoke('hotfix', 'checkout is on fire', '--commit', p.hotfix, '--on-behalf', 'demo');
    const goal = p.state('GOAL-BUG-001')!;
    expect(goal.status).toBe('draft');
    expect(goal.spec.acceptance).toHaveLength(0);
    expect(goal.hotfix?.commit).toBe(p.hotfix);
    expect(p.out.join('\n')).toMatch(/goal revise[\s\S]*bug approve GOAL-BUG-001/);
  });

  it('says in the log when L1 is red on the hotfix, and does not hold the hotfix up', async () => {
    const p = await hotfixProject();
    writeFileSync(
      join(p.dir, 'report.js'),
      'require(\'fs\').writeFileSync(process.argv[2],\'<testsuite name="s"><testcase classname="s" name="a"><failure message="x"/></testcase></testsuite>\');process.exitCode=1;',
    );
    p.git('add', '-A');
    p.git('commit', '-qm', 'broken suite');
    const red = p.git('rev-parse', 'HEAD');
    await p.invoke('hotfix', 'on fire', '--commit', red, '--on-behalf', 'demo');
    expect(p.state('GOAL-BUG-001')!.hotfix?.layers).toEqual([expect.objectContaining({ layer: 'L1', status: 'fail' })]);
    expect(p.out.join('\n')).toContain('hotfix đỏ ở L1');
  });

  describe('the commit before the hotfix', () => {
    it('a merge commit is refused unless --before names an ancestor of it', async () => {
      const p = await hotfixProject();
      p.git('checkout', '-q', '-b', 'side', p.before);
      writeFileSync(join(p.dir, 'side.txt'), 'x');
      p.git('add', '-A');
      p.git('commit', '-qm', 'side');
      p.git('checkout', '-q', 'main');
      p.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const merge = p.git('rev-parse', 'HEAD');
      const refused = p.invoke('hotfix', 'on fire', '--commit', merge, '--on-behalf', 'demo');
      await expect(refused).rejects.toThrow(/merge commit.*--before/);
      await expect(
        p.invoke('hotfix', 'on fire', '--commit', merge, '--before', 'f'.repeat(40), '--on-behalf', 'demo'),
      ).rejects.toThrow(/not a commit/);
      await expect(
        p.invoke('hotfix', 'on fire', '--commit', p.hotfix, '--before', merge, '--on-behalf', 'demo'),
      ).rejects.toThrow(/not an ancestor/);
      await p.invoke('hotfix', 'on fire', '--commit', merge, '--before', p.before, '--on-behalf', 'demo');
      expect(p.state('GOAL-BUG-001')!.hotfix).toMatchObject({ commit: merge, before: p.before });
    });

    it('a root commit has no parent: refused without --before, and --before cannot name the commit itself', async () => {
      const p = await hotfixProject();
      const root = p.git('rev-list', '--max-parents=0', 'HEAD');
      await expect(p.invoke('hotfix', 'on fire', '--commit', root, '--on-behalf', 'demo')).rejects.toThrow(
        /no parent.*--before/,
      );
      await expect(
        p.invoke('hotfix', 'on fire', '--commit', p.hotfix, '--before', p.hotfix, '--on-behalf', 'demo'),
      ).rejects.toThrow(/itself/);
      expect(p.open(journal => journal.listGoals())).toHaveLength(0);
    });
  });

  it('refuses a due without a unit, half a Given/When/Then, a missing commit and the same hotfix twice', async () => {
    const p = await hotfixProject();
    const base = ['hotfix', 'on fire', '--commit', p.hotfix, '--on-behalf', 'demo'];
    await expect(p.invoke(...base, '--due', '24')).rejects.toThrow(/unit/);
    await expect(p.invoke(...base, '--given', 'g')).rejects.toThrow(/come together/);
    await expect(p.invoke('hotfix', 'on fire', '--on-behalf', 'demo')).rejects.toThrow(/--commit/);
    await expect(p.invoke('hotfix', '--commit', p.hotfix, '--on-behalf', 'demo')).rejects.toThrow(/on fire/);
    await p.invoke(...base, '--due', '90m');
    expect(p.state('GOAL-BUG-001')!.hotfix?.dueAt).toBe('2026-11-24T09:30:00.000Z');
    await expect(p.invoke(...base)).rejects.toThrow(/already accepted: GOAL-BUG-001/);
  });

  it('takes the check from --check when the project has no setup, and says no layer ran', async () => {
    const p = await hotfixProject({ withSetup: false });
    await expect(
      p.invoke('hotfix', 'on fire', '--commit', p.hotfix, ...hotfixArgs, '--on-behalf', 'demo'),
    ).rejects.toThrow(/--check/);
    await p.invoke(
      'hotfix',
      'on fire',
      '--commit',
      p.hotfix,
      ...hotfixArgs,
      '--check',
      'npm test',
      '--on-behalf',
      'demo',
    );
    const goal = p.state('GOAL-BUG-001')!;
    expect(goal.spec.checks[0]).toMatchObject({ command: 'npm test' });
    expect(goal.hotfix?.layers).toEqual([]);
    expect(p.out.join('\n')).toContain('no approved setup');
  });
});

describe('apos hotfix list', () => {
  it('lists each hotfix with its state, deadline and Goal, and the count of those without evidence', async () => {
    const p = await hotfixProject();
    await p.invoke('hotfix', 'list');
    expect(p.out.join('\n')).toContain('No hotfix yet.');
    p.out.length = 0;
    await p.invoke('hotfix', 'checkout is on fire', '--commit', p.hotfix, ...hotfixArgs, '--on-behalf', 'demo');
    p.out.length = 0;
    await p.invoke('hotfix', 'list');
    expect(p.out.join('\n')).toContain(
      `GOAL-BUG-001\tđang chờ\t${p.hotfix.slice(0, 7)}\thạn 2026-11-25T08:00:00.000Z\tcheckout is on fire`,
    );
    expect(p.out.join('\n')).toContain('hotfix chưa có bằng chứng: 1');
    process.env.APOS_NOW = '2026-11-26T08:00:00.000Z';
    p.out.length = 0;
    await p.invoke('hotfix', 'list');
    expect(p.out.join('\n')).toContain('quá hạn');
  });
});
