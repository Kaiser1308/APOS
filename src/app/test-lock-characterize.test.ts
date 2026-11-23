import { afterEach, describe, expect, it } from 'vitest';
import { cleanProjects, mapFor, setupDocument, testingProject } from './test-lock.test-support.js';
import { spec } from '../domain/fixtures.test-support.js';

afterEach(cleanProjects);

/** Characterize Goals say which code they capture; their one criterion is stays-green by default. */
const characterize = { ...spec, kind: 'characterize' as const, covers: ['src/legacy.txt'] };
const total = 'tests.acceptance.calc::total';
const capture = (goalId: string, line = 'case total pass') => ({
  'tests/acceptance/calc.t': `${line}\n`,
  [`.apos/goals/${goalId}/tests.json`]: mapFor(goalId, [total]),
});
/** The legacy project: the code exists (src/legacy.txt) and nothing tests it. */
const project = (options: Parameters<typeof testingProject>[0] = {}) =>
  testingProject({ goal: characterize, files: { 'src/impl.txt': 'add\n', 'src/legacy.txt': 'legacy\n' }, ...options });

describe('tests submit for a characterize Goal', () => {
  it('locks tests that are green on the code as it is, and reads the criterion as stays-green', async () => {
    const p = await project();
    expect(p.state().spec.acceptance[0]?.proof).toBe('stays-green');
    const commit = p.commit(capture(p.goalId), 'capture');
    expect(await p.service.submit(p.goalId, commit, 'tester')).toEqual({ ok: true, problems: [] });
    expect(p.state().testLock?.commit).toBe(commit);
  }, 60_000);

  it('refuses a test that is red on the current code: capturing behaviour must be green as it is (review focus 3)', async () => {
    const p = await project();
    const commit = p.commit(capture(p.goalId, 'case total fail 0 is not 40'), 'capture');
    const result = await p.service.submit(p.goalId, commit, 'tester');
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('chụp hành vi phải xanh trên code như hiện tại');
    expect(p.state().testLock).toBeUndefined();
  }, 60_000);

  it('refuses a Tester who changes code, a stub or test infrastructure (review focus 3)', async () => {
    const p = await project();
    for (const [file, content] of [
      ['src/legacy.txt', 'edited\n'],
      ['src/stub.txt', 'stub\n'],
      ['tests/infra.cfg', 'swallow\n'],
    ] as const) {
      const result = await p.service.submit(
        p.goalId,
        p.commit({ ...capture(p.goalId), [file]: content }, file),
        'tester',
      );
      expect(result.ok, file).toBe(false);
      expect(result.problems.join('\n'), file).toContain(`${file}: characterize: the Tester adds tests only`);
    }
    expect(p.state().testLock).toBeUndefined();
  }, 180_000);

  it('refuses code changed in any commit of the Goal, even one a later commit puts back', async () => {
    const p = await project();
    p.commit({ 'src/legacy.txt': 'tampered\n' }, 'fix the code so the test is easy');
    const commit = p.commit({ ...capture(p.goalId), 'src/legacy.txt': 'legacy\n' }, 'capture, code put back');
    const result = await p.service.submit(p.goalId, commit, 'tester');
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/src\/legacy\.txt: characterize: .*in commit \w{7}/);
    expect(p.state().testLock).toBeUndefined();
  }, 60_000);

  it('lets the tests import the code it captures, and no other internal module', async () => {
    const entryRule = {
      importPatterns: ['^use (\\S+)'],
      allowImports: [],
      moduleSeparator: '/',
      moduleFiles: ['{path}.txt'],
    };
    const setup = {
      ...setupDocument,
      parts: { app: { ...setupDocument.parts.app, tests: { ...setupDocument.parts.app.tests, entryRule } } },
    };
    const p = await project({ setup });
    const refused = await p.service.submit(
      p.goalId,
      p.commit(capture(p.goalId, 'use src/impl\ncase total pass'), 'imports a module the Goal does not cover'),
      'tester',
    );
    expect(refused.ok).toBe(false);
    expect(refused.problems.join('\n')).toContain('imports "src/impl"');
    const ok = await p.service.submit(
      p.goalId,
      p.commit(capture(p.goalId, 'use src/legacy\ncase total pass'), 'imports the covered code'),
      'tester',
    );
    expect(ok.problems).toEqual([]);
    expect(ok.ok).toBe(true);
  }, 120_000);

  it('leaves an ordinary Goal as it was', async () => {
    const p = await testingProject();
    const commit = p.commit({ ...capture(p.goalId, 'case total needs add'), 'src/stub.txt': 'stub\n' }, 'tests');
    expect((await p.service.submit(p.goalId, commit, 'tester')).ok).toBe(true);
  }, 60_000);
});

describe('the package gate of a characterize Goal', () => {
  it('sees code changed in a commit and put back, which the net diff does not', async () => {
    const { characterizeScopeCheck } = await import('./characterized-gate.js');
    const p = await project();
    const setup = p.loadSetup(p.state());
    const lock = p.commit(capture(p.goalId), 'capture');
    const clean = characterizeScopeCheck({
      repo: p.dir,
      setup,
      base: lock,
      head: p.commit({ 'tests/acceptance/more.t': 'case x pass\n' }),
    });
    expect(clean.status).toBe('pass');
    p.commit({ 'src/legacy.txt': 'tampered\n' }, 'edit the code');
    const head = p.commit({ 'src/legacy.txt': 'legacy\n' }, 'put it back');
    const seen = characterizeScopeCheck({ repo: p.dir, setup, base: lock, head });
    expect(seen.status).toBe('fail');
    expect(seen.reason).toMatch(/src\/legacy\.txt \(commit \w{7}\)/);
  }, 60_000);
});

describe('what a rename hides (Codex review of #45)', () => {
  it('sees the source of a production file moved into the tests directory: tests submit and the package gate', async () => {
    const { characterizeScopeCheck } = await import('./characterized-gate.js');
    const p = await project();
    const lock = p.commit(capture(p.goalId), 'capture');
    p.git('mv', 'src/legacy.txt', 'tests/unit/legacy.t');
    p.git('commit', '-qm', 'move the code into the tests');
    const head = p.git('rev-parse', 'HEAD');
    const seen = characterizeScopeCheck({ repo: p.dir, setup: p.loadSetup(p.state()), base: lock, head });
    expect(seen.status).toBe('fail');
    expect(seen.reason).toContain('src/legacy.txt');
    // The same move on the way to the lock.
    const q = await project();
    q.git('mv', 'src/legacy.txt', 'tests/unit/legacy.t');
    const commit = q.commit(capture(q.goalId), 'capture, and move the code into the tests');
    const refused = await q.service.submit(q.goalId, commit, 'tester');
    expect(refused.ok).toBe(false);
    expect(refused.problems.join('\n')).toContain('src/legacy.txt: characterize: the Tester adds tests only');
  }, 90_000);
});

describe('a merge that edits code (Codex review of #45)', () => {
  it('is seen by the per-commit scope check: two tests-only parents, and a merge that changes the code', async () => {
    const { characterizeScopeCheck } = await import('./characterized-gate.js');
    const p = await project();
    const lock = p.commit(capture(p.goalId), 'capture');
    p.git('checkout', '-q', '-b', 'side');
    p.commit({ 'tests/acceptance/side.t': 'case side pass\n' }, 'tests on a side branch');
    p.git('checkout', '-q', 'main');
    p.commit({ 'tests/acceptance/main.t': 'case main pass\n' }, 'tests on main');
    p.git('merge', '--no-commit', '--no-ff', 'side');
    const head = p.commit({ 'src/legacy.txt': 'changed inside the merge\n' }, 'merge, and edit the code');
    const seen = characterizeScopeCheck({ repo: p.dir, setup: p.loadSetup(p.state()), base: lock, head });
    expect(seen.status).toBe('fail');
    expect(seen.reason).toContain('src/legacy.txt');
    const clean = p.git('rev-parse', `${head}^`);
    expect(characterizeScopeCheck({ repo: p.dir, setup: p.loadSetup(p.state()), base: lock, head: clean }).status).toBe(
      'pass',
    );
  }, 90_000);
});
