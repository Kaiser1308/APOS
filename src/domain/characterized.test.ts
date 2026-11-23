import { describe, expect, it } from 'vitest';
import { characterizedCheck, CHARACTERIZED_CHECK, refactorScopeCheck } from './characterized.js';
import type { Characterization } from './legacy.js';
import type { TestLock } from './test-lock.js';

const lock = {
  commit: 'a'.repeat(40),
  files: { 'tests/test_a.py': 'h1' },
  asserts: {},
  map: [{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['t1', 't2'] }],
  by: 't',
} as TestLock;
const source: Characterization = { goalId: 'GOAL-A', covers: ['legacy/**'], lock };
const green = { 'app.L2::t1': 'pass', 'app.L2::t2': 'pass' } as const;
const input = {
  sources: [source],
  deliveryFiles: { 'tests/test_a.py': 'h1' } as Record<string, string | undefined>,
  delivery: { ...green } as Record<string, 'pass' | 'fail' | 'error' | 'skip'>,
  base: { ...green } as Record<string, 'pass' | 'fail' | 'error' | 'skip'>,
};

describe('characterizedCheck', () => {
  it('passes when every captured test is green before and after and the file is untouched, and counts them', () => {
    const check = characterizedCheck(input);
    expect(check).toMatchObject({
      checkId: CHARACTERIZED_CHECK,
      status: 'pass',
      preserved: { tests: 2, from: ['GOAL-A'] },
    });
  });
  it('is red when the refactor made a captured test red, and names it', () => {
    const check = characterizedCheck({ ...input, delivery: { ...green, 'app.L2::t2': 'fail' } });
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('GOAL-A');
    expect(check.reason).toContain('app.L2 t2');
    expect(check.preserved).toBeUndefined();
  });
  it('is red when a captured test is gone from the report, its file changed or deleted', () => {
    const missing = characterizedCheck({ ...input, delivery: { 'app.L2::t1': 'pass' } });
    expect(missing.status).toBe('fail');
    expect(missing.reason).toContain('not in the delivery report');
    expect(characterizedCheck({ ...input, deliveryFiles: { 'tests/test_a.py': 'h2' } }).reason).toContain(
      'locked test modified: tests/test_a.py',
    );
    expect(characterizedCheck({ ...input, deliveryFiles: { 'tests/test_a.py': undefined } }).reason).toContain(
      '(deleted)',
    );
  });
  it('is red when the captured behaviour was not green on the base either', () => {
    const base = characterizedCheck({ ...input, base: { ...green, 'app.L2::t1': 'fail' } });
    expect(base.status).toBe('fail');
    expect(base.reason).toContain('is fail on the base');
    expect(characterizedCheck({ ...input, base: { 'app.L2::t1': 'pass' } }).reason).toContain('not in the base report');
  });
  it('is unverifiable when the layers did not run, and still red when a locked file was changed', () => {
    expect(characterizedCheck({ ...input, runProblems: ['app.L2: timed out'] }).status).toBe('unverifiable');
    expect(
      characterizedCheck({ ...input, runProblems: ['app.L2: timed out'], deliveryFiles: { 'tests/test_a.py': 'x' } })
        .status,
    ).toBe('fail');
  });
  it('is red with no characterization at all', () => {
    expect(characterizedCheck({ ...input, sources: [] }).status).toBe('fail');
  });
});

describe('refactorScopeCheck', () => {
  const base = {
    paths: ['legacy/pricing.py'],
    needsHuman: ['pyproject.toml'],
    lockedFiles: ['tests/test_a.py'],
    judged: ['pyproject.toml'],
  };
  it('passes when every changed file is inside the paths the Human approved', () => {
    expect(refactorScopeCheck({ ...base, changed: ['legacy/pricing.py', '.apos/goals/G/x.md'] }).status).toBe('pass');
  });
  it('is red for a file outside them, whatever the plan said: the Goal paths are the limit', () => {
    const check = refactorScopeCheck({ ...base, changed: ['legacy/pricing.py', 'legacy/shipping.py'] });
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('legacy/shipping.py');
    expect(check.reason).not.toContain('legacy/pricing.py,');
  });
  it('leaves locked tests, and a sensitive file a package gate already judged, to their own checks', () => {
    expect(refactorScopeCheck({ ...base, changed: ['pyproject.toml', 'tests/test_a.py'] }).status).toBe('pass');
  });
  it('is red for a sensitive file that only the integration commit changed: no package gate asked for a decision', () => {
    const check = refactorScopeCheck({ ...base, judged: [], changed: ['legacy/pricing.py', 'pyproject.toml'] });
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('pyproject.toml');
    expect(check.reason).toContain('integration itself');
  });
});

describe('two characterize Goals that locked the same file (Codex review of #45)', () => {
  // `sources` run from the oldest lock to the newest.
  const later = {
    goalId: 'GOAL-B',
    covers: ['legacy/**'],
    lock: {
      ...lock,
      commit: 'c'.repeat(40),
      files: { 'tests/test_a.py': 'h2' },
      map: [{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['t3'] }],
    } as TestLock,
  };
  const both = { ...input, sources: [source, later] };
  const all = { ...green, 'app.L2::t3': 'pass' } as Record<string, 'pass' | 'fail' | 'error' | 'skip'>;
  it('holds the file as the newest lock left it, which also holds the older tests', () => {
    const check = characterizedCheck({ ...both, deliveryFiles: { 'tests/test_a.py': 'h2' }, delivery: all, base: all });
    expect(check).toMatchObject({ status: 'pass', preserved: { tests: 3, from: ['GOAL-A', 'GOAL-B'] } });
  });
  it('is red for the older version of the file even when every test id still passes: the newer assertions are lost', () => {
    const rolledBack = characterizedCheck({
      ...both,
      deliveryFiles: { 'tests/test_a.py': 'h1' },
      delivery: all,
      base: all,
    });
    expect(rolledBack.status).toBe('fail');
    expect(rolledBack.reason).toContain('locked test modified: tests/test_a.py');
  });
  it('is red for a version no lock recorded', () => {
    expect(
      characterizedCheck({ ...both, deliveryFiles: { 'tests/test_a.py': 'h3' }, delivery: all, base: all }).status,
    ).toBe('fail');
  });

  it('holds the newest file even when the Goal that left it covers other code (disjoint capture scopes)', () => {
    // GOAL-A captures pricing, GOAL-B shipping; both put tests in the same file, B's version is newer. A pricing-only refactor leans on A.
    const other = { ...later, goalId: 'GOAL-B', covers: ['legacy/shipping.py'] };
    const check = characterizedCheck({
      ...input,
      sources: [source],
      held: [source, other],
      deliveryFiles: { 'tests/test_a.py': 'h2' },
    });
    expect(check.status).toBe('pass');
    expect(
      characterizedCheck({
        ...input,
        sources: [source],
        held: [source, other],
        deliveryFiles: { 'tests/test_a.py': 'h1' },
      }).status,
    ).toBe('fail');
  });
});
