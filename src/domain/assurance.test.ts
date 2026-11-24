import { describe, expect, it } from 'vitest';
import { infraCheck, inventoryCheck, lockedTestsCheck, scopeCheck } from './assurance.js';
import { summarizeGate } from './gate.js';

const lock = {
  commit: 'c'.repeat(40),
  files: { 'tests/a.t': 'a'.repeat(64), 'tests/b.t': 'b'.repeat(64) },
  asserts: { 'tests/a.t': 1, 'tests/b.t': 1 },
  map: [
    { acceptanceId: 'AC-1', part: 'app', layer: 'L2' as const, testIds: ['x', 'y'] },
    { acceptanceId: 'AC-2', part: 'app', layer: 'L2' as const, testIds: ['z'] },
  ],
  by: 't',
};
const same = { 'tests/a.t': 'a'.repeat(64), 'tests/b.t': 'b'.repeat(64) };

describe('lockedTestsCheck', () => {
  it("passes when no locked file changed and the package's tests pass; other packages' tests are not its business", () => {
    const check = lockedTestsCheck({
      lock,
      deliveryFiles: same,
      delivery: { 'app.L2::x': 'pass', 'app.L2::y': 'pass', 'app.L2::z': 'fail' },
      criteria: ['AC-1'],
    });
    expect(check).toMatchObject({ checkId: 'APOS-LOCKED', status: 'pass' });
  });
  it('is red naming a locked file that differs, even by one byte, or is gone (review focus 5)', () => {
    const check = lockedTestsCheck({
      lock,
      deliveryFiles: { 'tests/a.t': 'f'.repeat(64), 'tests/b.t': undefined },
      delivery: { 'app.L2::x': 'pass', 'app.L2::y': 'pass' },
      criteria: ['AC-1'],
    });
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('locked test modified: tests/a.t');
    expect(check.reason).toContain('locked test modified: tests/b.t (deleted)');
  });
  it('is red for a test that does not pass or is not in the delivery report', () => {
    const check = lockedTestsCheck({
      lock,
      deliveryFiles: same,
      delivery: { 'app.L2::x': 'fail' },
      criteria: ['AC-1'],
    });
    expect(check.reason).toBe('AC-1 app.L2 x: is fail, not pass; AC-1 app.L2 y: not in the delivery report');
  });
});

describe('inventoryCheck', () => {
  const base = { 'app.L1::u1': 'pass', 'app.L2::x': 'fail', 'app.L1::skipped': 'skip', 'app.L1::e': 'error' } as const;
  it('passes when every test of the base is still there, and a skipped one may stay skipped', () => {
    const check = inventoryCheck({
      base,
      delivery: { ...base, 'app.L2::x': 'pass', 'app.L1::new': 'pass' },
      addedLines: ['x = 1'],
      forbid: ['@skip'],
    });
    expect(check).toMatchObject({ checkId: 'APOS-INVENTORY', status: 'pass' });
  });
  it('is red for a test that vanished, or turned into a skip', () => {
    const check = inventoryCheck({
      base,
      delivery: { 'app.L2::x': 'skip', 'app.L1::skipped': 'skip', 'app.L1::e': 'pass' },
      addedLines: [],
      forbid: [],
    });
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('test missing: app.L1::u1; test now skipped: app.L2::x');
  });
  it('is red for a forbidden pattern in an added line, naming the line', () => {
    const check = inventoryCheck({
      base: {},
      delivery: {},
      addedLines: ['  @pytest.mark.skip'],
      forbid: ['@pytest\\.mark\\.skip'],
    });
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('@pytest.mark.skip');
  });
});

describe('inventoryCheck with declared removals', () => {
  const base = {
    'app.L1::tests.old::a': 'pass',
    'app.L1::tests.old::b': 'pass',
    'app.L1::tests.keep::c': 'pass',
    'app.L1::tests.keep::d': 'pass',
  } as const;
  const removable = [{ acceptanceId: 'AC-1', entry: 'app.L1::tests.old' }];
  const run = (delivery: Record<string, 'pass' | 'fail' | 'error' | 'skip'>, extra = {}) =>
    inventoryCheck({ base, delivery, addedLines: [], forbid: [], removable, ...extra });

  it('passes when exactly the declared tests are gone, and counts them (and whose locks they were)', () => {
    const check = run(
      { 'app.L1::tests.keep::c': 'pass', 'app.L1::tests.keep::d': 'pass' },
      { lockedBy: (key: string) => (key.endsWith('::a') ? 'GOAL-OLD' : undefined) },
    );
    expect(check.status).toBe('pass');
    expect(check.removal).toEqual({
      tests: ['app.L1::tests.old::a', 'app.L1::tests.old::b'],
      locked: [{ goalId: 'GOAL-OLD', tests: ['app.L1::tests.old::a'] }],
    });
  });
  it('is red naming a test that was lost without being declared (Review Focus 1)', () => {
    const check = run({ 'app.L1::tests.keep::c': 'pass' });
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('test missing: app.L1::tests.keep::d');
  });
  it('is red when a declared test is still there, whatever its status (Review Focus 2)', () => {
    const delivery = {
      'app.L1::tests.old::a': 'pass',
      'app.L1::tests.keep::c': 'pass',
      'app.L1::tests.keep::d': 'pass',
    } as const;
    const check = run(delivery);
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('declared removed but still there: app.L1::tests.old::a');
    expect(run({ ...delivery, 'app.L1::tests.old::a': 'skip' }).reason).toMatch(/still there: app.L1::tests.old::a/);
  });
  it('is red for a test under a declared file that the base did not have: a rename does not remove it (Codex)', () => {
    const check = run({
      'app.L1::tests.old::renamed': 'pass',
      'app.L1::tests.keep::c': 'pass',
      'app.L1::tests.keep::d': 'pass',
    });
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('declared removed but still there: app.L1::tests.old::renamed');
  });
  it('is red for a declared test the base does not have', () => {
    const check = run(
      { 'app.L1::tests.keep::c': 'pass', 'app.L1::tests.keep::d': 'pass' },
      { removable: [...removable, { acceptanceId: 'AC-1', entry: 'app.L1::tests.ghost::z' }] },
    );
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('declared removed but not on the base: app.L1::tests.ghost::z');
  });
  it('changes nothing for a Goal that declares none', () => {
    const check = inventoryCheck({ base, delivery: {}, addedLines: [], forbid: [] });
    expect(check.removal).toBeUndefined();
    expect(check.reason).toContain('test missing: app.L1::tests.old::a');
  });
});

describe('scopeCheck', () => {
  const base = { paths: ['src/**'], needsHuman: ['pyproject.toml'], lockedFiles: ['tests/a.t'] };
  it("passes for files inside paths; .apos files and locked files are other checks' business", () => {
    expect(scopeCheck({ ...base, changed: ['src/a.py', '.apos/goals/G/goal.md', 'tests/a.t'] }).status).toBe('pass');
  });
  it('is red for a file outside paths', () => {
    const check = scopeCheck({ ...base, changed: ['src/a.py', 'docs/x.md'] });
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('docs/x.md');
  });
  it('asks a decision for a needsHuman file even outside paths, and red wins when something else is out of scope', () => {
    expect(scopeCheck({ ...base, changed: ['pyproject.toml'] })).toMatchObject({
      status: 'needs-human',
      checkId: 'APOS-SCOPE',
    });
    expect(scopeCheck({ ...base, changed: ['pyproject.toml', 'docs/x.md'] }).status).toBe('fail');
  });
});

describe('summarizeGate with needs-human', () => {
  const check = (status: 'pass' | 'fail' | 'unverifiable' | 'needs-human' | 'manual-pending') => ({
    checkId: 'X',
    status,
    reason: '',
    base: [],
    delivery: [],
    newFailures: [],
  });
  it('orders red, unverifiable, needs-human, pending, green', () => {
    expect(summarizeGate([check('needs-human'), check('fail')])).toBe('red');
    expect(summarizeGate([check('needs-human'), check('unverifiable')])).toBe('unverifiable');
    expect(summarizeGate([check('manual-pending'), check('needs-human')])).toBe('needs-human');
    expect(summarizeGate([check('manual-pending'), check('pass')])).toBe('pending');
    expect(summarizeGate([check('pass')])).toBe('green');
  });
});

describe('lockedTestsCheck when the layers did not run', () => {
  it('a changed locked file is red even if the delivery also broke the runner; unchanged files give unverifiable', () => {
    const run = {
      lock,
      delivery: {},
      criteria: ['AC-1'],
      runProblems: ['app.L2 acceptance: command not found: pytest'],
    };
    const changed = lockedTestsCheck({
      ...run,
      deliveryFiles: { 'tests/a.t': 'f'.repeat(64), 'tests/b.t': 'b'.repeat(64) },
    });
    expect(changed.status).toBe('fail');
    expect(changed.reason).toBe('locked test modified: tests/a.t');
    expect(lockedTestsCheck({ ...run, deliveryFiles: same })).toMatchObject({
      status: 'unverifiable',
      reason: 'the delivery layers did not run: app.L2 acceptance: command not found: pytest',
    });
  });
});

describe('infraCheck', () => {
  const lockInfra = { 'tests/conftest.py': 'a'.repeat(64), 'pytest.ini': 'b'.repeat(64) };
  it('passes when every infra file is as locked', () => {
    expect(infraCheck({ lockInfra, delivery: { ...lockInfra } })).toMatchObject({
      checkId: 'APOS-INFRA',
      status: 'pass',
    });
  });
  it('asks a decision for an infra file that changed, was added or was deleted, naming each', () => {
    const check = infraCheck({
      lockInfra,
      delivery: { 'tests/conftest.py': 'f'.repeat(64), 'tox.ini': 'c'.repeat(64) },
    });
    expect(check).toMatchObject({
      status: 'needs-human',
      reason: 'hạ tầng test bị sửa: pytest.ini, tests/conftest.py, tox.ini',
    });
  });
  it('does not charge a package for a file its green dependency already brought', () => {
    const check = infraCheck({
      lockInfra,
      delivery: { ...lockInfra, 'tox.ini': 'c'.repeat(64) },
      inherited: new Set(['tox.ini']),
    });
    expect(check.status).toBe('pass');
  });
});
