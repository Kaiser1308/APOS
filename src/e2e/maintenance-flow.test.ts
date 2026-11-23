import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { hasPytest, openProject, python } from './layers-scenario.test-support.js';

/**
 * A maintenance Goal through the CLI with real pytest: a test that was already red on the base does not make the delivery
 * red (the table counts it), a test that was green and is red after the upgrade does, and so does a finding the base did
 * not have. Skipped when pytest is not on this machine.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const DEP_TEST = 'def test_dependency_is_not_poisoned():\n    assert "poison" not in open("Pipfile").read()\n';
const KNOWN_RED = 'def test_known_defect():\n    assert False, "known defect on the base"\n';

async function opened() {
  const p = openProject(python, dirs);
  await p.setUp();
  // The project today: a Pipfile (a manifest), a test that reads it, a test already red, and one finding the scan reports.
  p.commit(
    {
      Pipfile: '[packages]\nrequests = "==2.30.0"\n',
      'tests/test_dependency.py': DEP_TEST,
      'tests/test_known.py': KNOWN_RED,
      'perf/findings.txt': 'error\n',
    },
    'the project today',
  );
  const say = (code: number | undefined, text: string) => `${code ?? 0}: ${text}`;
  expect(say((await p.invoke('maintenance', 'open', 'Bump requests', '--paths', 'perf/**')).code, '')).toBe('0: ');
  expect((await p.invoke('maintenance', 'approve', 'GOAL-MAINT-001', ...p.human)).code ?? 0).toBe(0);
  expect((await p.invoke('lead', 'propose', '--maintenance', '--goal', 'GOAL-MAINT-001')).code ?? 0).toBe(0);
  expect((await p.invoke('lead', 'commit', 'GOAL-MAINT-001')).code ?? 0).toBe(0);
  return p;
}

describe.skipIf(!hasPytest)('apos maintenance with pytest', () => {
  it('a test already red on the base is not a new failure, and the table counts it', async () => {
    const p = await opened();
    const bump = p.commit({ Pipfile: '[packages]\nrequests = "==2.31.0"\n' }, 'bump requests');
    const done = await p.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN', '--commit', bump);
    expect(done.code ?? 0).toBe(0);
    expect(done.text).toContain('verified');
    const table = await p.invoke('goal', 'show', 'GOAL-MAINT-001');
    expect(table.text).toContain('lỗi có sẵn trên base: 1; lỗi mới: 0');
    expect(table.text).toContain('finding mới 0');
  }, 240_000);

  it('a test that was green and is red after the upgrade is red, and is named', async () => {
    const p = await opened();
    const bad = p.commit({ Pipfile: '[packages]\npoison = "*"\n' }, 'bump to a poisoned package');
    const red = await p.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN', '--commit', bad);
    expect(red.code).toBe(1);
    expect(red.text).toContain('test_dependency_is_not_poisoned');
    expect(red.text).toContain('new failure(s) vs the base');
  }, 240_000);

  it('a finding the base did not have is red, one it had is not', async () => {
    const p = await opened();
    const more = p.commit({ 'perf/findings.txt': 'error error\n' }, 'the upgrade adds a finding');
    const red = await p.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN', '--commit', more);
    expect(red.code).toBe(1);
    expect(red.text).toMatch(/1 new finding\(s\) vs the base at error or above: FAKE1/);
  }, 240_000);
});
