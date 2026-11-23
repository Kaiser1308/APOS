import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { hasPytest, openProject, python } from './layers-scenario.test-support.js';

/**
 * `apos bug` through the CLI with real pytest: a reproduction test that is green on the code as it is does not reproduce
 * the bug and is refused; one that is red on the bug is locked. Skipped when pytest is not on this machine.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe.skipIf(!hasPytest)('apos bug with pytest', () => {
  it('refuses a reproduction test that is green on the bug, and locks one that is red', async () => {
    const a = python.modules.a;
    const p = openProject(python, dirs);
    await p.setUp();
    // The module that has the bug: `add` is wrong only for negative numbers, so a test of 1 + 2 is green.
    p.commit({ [a.stub]: 'def add(a, b):\n    return abs(a) + abs(b)\n' }, 'the code today');
    await p.invoke(
      'bug',
      'open',
      'add is wrong for negative numbers',
      '--given',
      'two numbers, one negative',
      '--when',
      'they are added',
      '--then',
      'the sum is signed',
      '--repro-hint',
      a.stub,
    );
    expect((await p.invoke('bug', 'approve', 'GOAL-BUG-001')).code).toBe(1);
    expect((await p.invoke('bug', 'approve', 'GOAL-BUG-001', ...p.human)).code ?? 0).toBe(0);
    expect((await p.invoke('lead', 'propose', '--bugfix', '--goal', 'GOAL-BUG-001')).code ?? 0).toBe(0);
    expect((await p.invoke('lead', 'commit', 'GOAL-BUG-001')).code ?? 0).toBe(0);
    const map = JSON.stringify([{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [a.testId] }]);
    const mapPath = '.apos/goals/GOAL-BUG-001/tests.json';

    const green = p.commit({ [a.test]: a.testSource, [mapPath]: map }, 'a test that is green on the bug');
    const refused = await p.invoke('tests', 'submit', 'GOAL-BUG-001', '--commit', green);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('test không tái hiện lỗi');
    expect(p.state('GOAL-BUG-001').testLock).toBeUndefined();

    const red = p.commit(
      { [a.test]: 'from adder import add\n\n\ndef test_add():\n    assert add(-1, 2) == 1\n' },
      'a test that fails on the bug',
    );
    const locked = await p.invoke('tests', 'submit', 'GOAL-BUG-001', '--commit', red);
    expect(locked.code ?? 0).toBe(0);
    expect(p.state('GOAL-BUG-001').testLock?.commit).toBe(red);
  }, 240_000);
});
