import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { hasPytest, openProject, python } from './layers-scenario.test-support.js';

/**
 * `apos hotfix` through the CLI with real pytest: a merge commit cannot be a hotfix unless the Human says which commit is
 * "before" it, and a delivery that does not contain the hotfix commit is red even when its locked test is green.
 * Skipped when pytest is not on this machine.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe.skipIf(!hasPytest)('apos hotfix with pytest', () => {
  it('refuses a merge commit without --before, and a delivery without the hotfix commit is red', async () => {
    const a = python.modules.a;
    const p = openProject(python, dirs);
    await p.setUp();
    const before = p.commit({ [a.stub]: 'def add(a, b):\n    return abs(a) + abs(b)\n' }, 'the code today');
    const hotfix = p.commit({ [a.stub]: 'def add(a, b):\n    return a + b\n' }, 'hotfix: add is signed');

    // A merge commit has no single commit "before" it.
    p.git('checkout', '-q', '-b', 'side', before);
    p.commit({ 'notes.txt': 'side work\n' }, 'side work');
    p.git('checkout', '-q', 'main');
    p.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const merge = p.git('rev-parse', 'HEAD');
    const refused = await p.invoke('hotfix', 'add is wrong', '--commit', merge, ...p.human);
    expect(refused.code).toBe(1);
    expect(refused.text).toMatch(/merge commit.*--before/);
    expect(p.state('GOAL-BUG-001')).toBeUndefined();

    const taken = await p.invoke(
      'hotfix',
      'add is wrong for negative numbers',
      '--commit',
      hotfix,
      '--given',
      'two numbers, one negative',
      '--when',
      'they are added',
      '--then',
      'the sum is signed',
      ...p.human,
    );
    expect(taken.code ?? 0).toBe(0);
    expect(p.state('GOAL-BUG-001').hotfix?.before).toBe(before);
    expect((await p.invoke('lead', 'propose', '--bugfix', '--goal', 'GOAL-BUG-001')).code ?? 0).toBe(0);
    expect(p.state('GOAL-BUG-001').proposal?.baseCommit).toBe(before);
    expect((await p.invoke('lead', 'commit', 'GOAL-BUG-001')).code ?? 0).toBe(0);

    // The Tester works on the commit before the hotfix, where the bug is.
    p.git('checkout', '-q', '--detach', before);
    const map = JSON.stringify([{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [a.testId] }]);
    const red = p.commit(
      {
        [a.test]: 'from adder import add\n\n\ndef test_add():\n    assert add(-1, 2) == 1\n',
        '.apos/goals/GOAL-BUG-001/tests.json': map,
      },
      'a test that fails on the bug',
    );
    expect((await p.invoke('tests', 'submit', 'GOAL-BUG-001', '--commit', red)).code ?? 0).toBe(0);

    // A fix of their own is not the hotfix: red, though the locked test is green on it.
    const own = p.commit({ [a.stub]: 'def add(a, b):\n    return a + b\n' }, 'a fix of my own');
    const missing = await p.invoke('package', 'submit', 'GOAL-BUG-001', 'WP-MAIN', '--commit', own);
    expect(missing.code).toBe(1);
    expect(missing.text).toContain('APOS-HOTFIX fail');
    expect(p.state('GOAL-BUG-001').status).toBe('executing');

    p.git('checkout', '-q', '--detach', red);
    p.git('merge', '-q', '--no-edit', hotfix);
    const delivery = p.git('rev-parse', 'HEAD');
    const green = await p.invoke('package', 'submit', 'GOAL-BUG-001', 'WP-MAIN', '--commit', delivery);
    expect(green.code ?? 0).toBe(0);
    expect(p.state('GOAL-BUG-001').status).toBe('verified');
  }, 300_000);
});
