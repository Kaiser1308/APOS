import { afterEach, describe, expect, it } from 'vitest';
import { cleanProjects, goodTests, ids, mapFor, testingProject } from './test-lock.test-support.js';
import { sha256Of } from './git-files.js';

afterEach(cleanProjects);

const submitted = async (
  files: Record<string, string | null>,
  override?: (p: Awaited<ReturnType<typeof testingProject>>) => string,
) => {
  const p = await testingProject();
  const commit = override ? override(p) : p.commit(files, 'tests');
  const result = await p.service.submit(p.goalId, commit, 'tester');
  return { p, commit, result };
};

describe('tests submit', () => {
  it('locks a suite that is red because the stub is not implemented, hashing each file and counting asserts', async () => {
    const p = await testingProject();
    const files = {
      ...goodTests(p.goalId),
      'tests/acceptance/calc.t': 'case add needs add\ncase sub needs sub\n',
      [`.apos/goals/${p.goalId}/tests.json`]: mapFor(p.goalId, [ids.add, ids.sub]),
    };
    const commit = p.commit(files, 'tests');
    const result = await p.service.submit(p.goalId, commit, 'tester');
    expect(result).toEqual({ ok: true, problems: [] });
    const state = p.state();
    expect(state.status).toBe('executing');
    expect(state.testLock).toMatchObject({
      commit,
      by: 'tester',
      asserts: { 'tests/acceptance/calc.t': 2 },
      map: [{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [ids.add, ids.sub] }],
    });
    expect(state.testLock?.files['tests/acceptance/calc.t']).toBe(
      sha256Of(Buffer.from('case add needs add\ncase sub needs sub\n')),
    );
    expect(Object.keys(state.testLock?.files ?? {})).toEqual(['tests/acceptance/calc.t']);
  }, 60_000);

  it('accepts an error that says "not implemented", the way a JUnit stub reports it', async () => {
    const { result } = await submitted({
      ...goodTests('GOAL-001'),
      'tests/acceptance/calc.t': 'case add needs-err add\n',
    });
    expect(result.ok).toBe(true);
  }, 60_000);

  it('refuses a test that is already green and names it (review focus 1)', async () => {
    const { p, result } = await submitted({ ...goodTests('GOAL-001'), 'tests/acceptance/calc.t': 'case add pass\n' });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining(`AC-1 app.L2 ${ids.add}: already green`) as unknown]);
    expect(p.state().status).toBe('testing');
    expect(p.state().testLock).toBeUndefined();
  }, 60_000);

  it('refuses a test that is red because it did not load, or because of a typo (review focus 2)', async () => {
    const load = await submitted({ ...goodTests('GOAL-001'), 'tests/acceptance/calc.t': 'case add load\n' });
    expect(load.result.problems.join('\n')).toMatch(/the test did not load: ImportError/);
    const typo = await submitted({ ...goodTests('GOAL-001'), 'tests/acceptance/calc.t': 'case add typo\n' });
    expect(typo.result.problems.join('\n')).toMatch(/errored with something other than "not implemented": NameError/);
    expect(load.p.state().status).toBe('testing');
  }, 90_000);

  it('refuses a test the report does not hold, so a file that never loaded is not red', async () => {
    const { result } = await submitted({
      ...goodTests('GOAL-001'),
      'tests/acceptance/calc.t': 'case other needs add\n',
    });
    expect(result.problems.join('\n')).toMatch(new RegExp(`${ids.add}: not in the report`));
  }, 60_000);

  it('lets the tester touch tests, declared stubs and tests.json, and nothing else', async () => {
    const { result } = await submitted({ ...goodTests('GOAL-001'), 'src/impl.txt': 'add\n', 'README.md': 'x\n' });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^README\.md: not a test file/) as unknown,
        expect.stringMatching(/^src\/impl\.txt: not a test file/) as unknown,
      ]),
    );
  }, 60_000);

  it('does not count the milestone documents APOS itself committed after the base', async () => {
    const p = await testingProject();
    // proposal-approved already committed .apos/goals/<id>/*.md on top of the base.
    const commit = p.commit(goodTests(p.goalId), 'tests');
    expect(p.git('diff', '--name-only', p.base, commit)).toMatch(/\.apos\/goals\/GOAL-001\/goal\.md/);
    expect((await p.service.submit(p.goalId, commit, 'tester')).ok).toBe(true);
  }, 60_000);

  it('needs tests.json, a test for every criterion, and only criteria and parts that exist', async () => {
    const none = await submitted({ 'tests/acceptance/calc.t': 'case add needs add\n', 'src/stub.txt': 's\n' });
    expect(none.result.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('tests.json is missing from the commit') as unknown,
        expect.stringContaining('AC-1 has no test') as unknown,
      ]),
    );
    const wrong = await submitted({
      ...goodTests('GOAL-001'),
      '.apos/goals/GOAL-001/tests.json': JSON.stringify([
        { acceptanceId: 'AC-9', part: 'ghost', layer: 'L2', testIds: [ids.add] },
      ]),
    });
    expect(wrong.result.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AC-9, which is not a criterion') as unknown,
        expect.stringContaining('part "ghost"') as unknown,
        expect.stringContaining('AC-1 has no test') as unknown,
      ]),
    );
    const badJson = await submitted({ ...goodTests('GOAL-001'), '.apos/goals/GOAL-001/tests.json': '{' });
    expect(badJson.result.problems.join('\n')).toMatch(/not valid JSON/);
  }, 120_000);

  it('refuses a commit that does not contain the plan base, telling the tester to rebase (review focus 3)', async () => {
    const p = await testingProject();
    p.git('checkout', '-q', '--orphan', 'elsewhere');
    const commit = p.commit({ ...goodTests(p.goalId), 'runner.js': 'x' }, 'tests on an unrelated branch');
    const result = await p.service.submit(p.goalId, commit, 'tester');
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/does not contain .* rebase onto it/);
  }, 60_000);

  it('refuses to delete an existing test file', async () => {
    const { result } = await submitted({ ...goodTests('GOAL-001'), 'tests/unit/u.t': null });
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/tests\/unit\/u\.t: a test file was deleted/) as unknown]),
    );
  }, 60_000);

  it('reports every problem at once, in order, and writes nothing', async () => {
    const { p, result } = await submitted({
      'tests/acceptance/calc.t': 'case add pass\n',
      'README.md': 'x\n',
    });
    expect(result.problems).toHaveLength(3);
    expect(result.problems[1]).toMatch(/tests\.json is missing/);
    expect(result.problems[2]).toMatch(/AC-1 has no test/);
    expect(p.state().testLock).toBeUndefined();
    expect(p.journal.events(p.goalId).some(item => item.type === 'tests-locked')).toBe(false);
  }, 60_000);

  it('refuses when two runs of the same commit disagree (flaky), and locks nothing', async () => {
    const p = await testingProject();
    const commit = p.commit(goodTests(p.goalId), 'tests');
    let calls = 0;
    const flaky = {
      layerTests: () => ({
        problems: [],
        tests: [
          { id: ids.add, status: calls++ % 2 ? ('pass' as const) : ('fail' as const), message: 'NotImplementedError' },
        ],
      }),
    };
    const { TestLockService } = await import('./test-lock.js');
    const service = new TestLockService(p.journal, {
      repoPath: p.dir,
      runner: flaky as never,
      loadSetup: p.loadSetup,
    });
    const result = await service.submit(p.goalId, commit, 'tester');
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/gave different results \(flaky\)/);
  }, 60_000);

  it('says what to do for a Goal that is not testing: already locked, or not yet committed', async () => {
    const p = await testingProject();
    const commit = p.commit(goodTests(p.goalId), 'tests');
    await p.service.submit(p.goalId, commit, 'tester');
    await expect(p.service.submit(p.goalId, commit, 'tester')).rejects.toThrow(
      /already has locked tests.*apos tests revise/,
    );
  }, 60_000);
});
