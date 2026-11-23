import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceText, spec } from '../domain/fixtures.test-support.js';
import { hasPytest, openProject, python } from './layers-scenario.test-support.js';

/**
 * A feature removed through the CLI with real pytest: the test that says it is gone must fail on an assertion (one that is
 * red because it cannot import is refused), a delivery that loses a test nobody declared is red and names it, and the one
 * that removes the feature and exactly the declared tests is green. Skipped when pytest is not on this machine.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const OLD = 'tests.test_vouchers';
const FEATURE = {
  'vouchers.py': 'def redeem(code):\n    return {"WELCOME": 5}.get(code, 0)\n',
  'tests/test_vouchers.py':
    'import vouchers\n\n\ndef test_a_known_code_is_worth_something():\n    assert vouchers.redeem("WELCOME") == 5\n\n\ndef test_an_unknown_code_is_worth_nothing():\n    assert vouchers.redeem("NOPE") == 0\n',
  'tests/test_keep.py': 'def test_keep():\n    assert True\n',
};
const ABSENCE = 'import vouchers\n\n\ndef test_vouchers_are_gone():\n    assert not hasattr(vouchers, "redeem")\n';
const MAP = JSON.stringify([
  { acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['tests.acceptance.test_gone::test_vouchers_are_gone'] },
]);
const MAP_PATH = '.apos/goals/GOAL-001/tests.json';

describe.skipIf(!hasPytest)('apos removal with pytest', () => {
  it('locks only a test of absence that fails on an assertion, and gates the removal against the declared tests', async () => {
    const p = openProject(python, dirs);
    await p.setUp();
    const base = p.commit(FEATURE, 'the project today, with vouchers');
    const goal = {
      ...spec,
      acceptance: [
        { ...spec.acceptance[0], proof: 'removed', removesTests: [`app.L1::${OLD}`], text: 'vouchers are gone' },
      ],
      checks: [{ ...spec.checks[0]!, command: 'pytest -q' }],
    };
    writeFileSync(join(p.dir, 'brief.md'), sourceText);
    await p.invoke('goal', 'create', '--file', p.json('goal.plan.json', goal), '--source', join(p.dir, 'brief.md'));
    const approved = await p.invoke(
      'goal',
      'approve',
      spec.id,
      '--size',
      'M',
      '--max-minutes',
      '240',
      '--max-attempts',
      '5',
      ...p.human,
    );
    expect(approved.code ?? 0).toBe(0);
    expect(approved.text).toContain(`app.L1::${OLD}::test_a_known_code_is_worth_something`);
    expect(approved.text).toContain(`app.L1::${OLD}::test_an_unknown_code_is_worth_nothing`);
    expect(approved.text).not.toContain('test_keep');
    await p.invoke('goal', 'select', spec.id, ...p.human);
    const plan = p.json('plan.plan.json', {
      id: 'EXEC-001',
      version: 1,
      goalId: spec.id,
      goalVersion: 1,
      mode: 'solo-direct',
      approach: 'drop redeem and its two tests',
      rationale: 'one module',
      risks: [],
      baseCommit: base,
      paths: ['vouchers.py', 'tests/test_vouchers.py'],
      stubPaths: ['vouchers.py'],
      entries: ['redeem'],
      acceptanceMapping: [{ acceptanceId: 'AC-1', verification: 'locked test of absence' }],
      verificationStrategy: 'the test of absence, then the inventory',
    });
    expect((await p.invoke('lead', 'propose', '--file', plan)).code ?? 0).toBe(0);
    expect((await p.invoke('lead', 'commit', spec.id)).code ?? 0).toBe(0);

    // Focus 4: red because the module it imports is not there says nothing about vouchers.
    const unloadable = p.commit(
      {
        'tests/acceptance/test_gone.py': ABSENCE.replace('import vouchers', 'import voucher_core as vouchers'),
        [MAP_PATH]: MAP,
      },
      'a test that cannot load',
    );
    const refused = await p.invoke('tests', 'submit', spec.id, '--commit', unloadable);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('the test did not load');
    expect(p.state(spec.id).testLock).toBeUndefined();

    // pytest reports an exception raised in a test's body as a failure, like an assertion: the message is what tells them apart.
    for (const [body, why] of [
      ['    from vouchers import nope\n', 'an import inside the body'],
      ['    vouchers.nope()\n', 'a call of something that was never there'],
    ] as const) {
      const wrong = p.commit(
        { 'tests/acceptance/test_gone.py': `import vouchers\n\n\ndef test_vouchers_are_gone():\n${body}` },
        `a test red because of ${why}`,
      );
      const no = await p.invoke('tests', 'submit', spec.id, '--commit', wrong);
      expect(no.code, why).toBe(1);
      expect(no.text, why).toContain('must fail on an assertion while it is still there');
    }
    // The Tester changes tests only: a vouchers.py rewritten to fail would make any test of absence red.
    const rewritten = p.commit(
      { 'tests/acceptance/test_gone.py': ABSENCE, 'vouchers.py': 'raise RuntimeError\n' },
      'code too',
    );
    const code = await p.invoke('tests', 'submit', spec.id, '--commit', rewritten);
    expect(code.code).toBe(1);
    expect(code.text).toContain('vouchers.py: removal: the Tester adds tests only');
    p.git('checkout', '-q', '--detach', base);

    const locked = p.commit({ 'tests/acceptance/test_gone.py': ABSENCE, [MAP_PATH]: MAP }, 'a test of absence');
    expect((await p.invoke('tests', 'submit', spec.id, '--commit', locked)).code ?? 0).toBe(0);

    const removal = { 'vouchers.py': '"""Vouchers were removed."""\n', 'tests/test_vouchers.py': null };
    // A Worker who also deletes a test nobody declared.
    p.git('checkout', '-q', '--detach', locked);
    const tooMuch = p.commit({ ...removal, 'tests/test_keep.py': null }, 'removes vouchers and a test too many');
    const red = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', tooMuch);
    expect(red.code).toBe(1);
    expect(red.text).toContain('test missing: app.L1::tests.test_keep::test_keep');

    // A Worker who removes the code and leaves a declared test, which now fails.
    p.git('checkout', '-q', '--detach', locked);
    const forgot = p.commit({ 'vouchers.py': '"""Vouchers were removed."""\n' }, 'removes the code only');
    const still = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', forgot);
    expect(still.code).toBe(1);
    expect(still.text).toContain(
      `declared removed but still there: app.L1::${OLD}::test_a_known_code_is_worth_something`,
    );

    p.git('checkout', '-q', '--detach', locked);
    const good = p.commit(removal, 'removes vouchers and exactly the declared tests');
    const green = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', good);
    expect(green.code ?? 0).toBe(0);
    expect(green.text).toContain('verified');
    const table = await p.invoke('goal', 'show', spec.id);
    expect(table.text).toContain('xoá đúng 2 test đã khai');
  }, 300_000);
});
