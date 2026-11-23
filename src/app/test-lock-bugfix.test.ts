import { afterEach, describe, expect, it } from 'vitest';
import { cleanProjects, mapFor, testingProject } from './test-lock.test-support.js';
import { spec } from '../domain/fixtures.test-support.js';

afterEach(cleanProjects);

const bug = { ...spec, kind: 'bugfix' as const };
const total = 'tests.acceptance.calc::total';
const repro = (goalId: string, line = 'case total fail 0 is not 40') => ({
  'tests/acceptance/calc.t': `${line}\n`,
  [`.apos/goals/${goalId}/tests.json`]: mapFor(goalId, [total]),
});
/** The project at its base: the code already works for `add` (src/impl.txt names it), and the bug is elsewhere. */
const project = () => testingProject({ goal: bug, files: { 'src/impl.txt': 'add\n' } });

describe('tests submit for a bugfix Goal', () => {
  it('locks a test that fails on the code as it is', async () => {
    const p = await project();
    const commit = p.commit(repro(p.goalId), 'repro');
    expect(await p.service.submit(p.goalId, commit, 'tester')).toEqual({ ok: true, problems: [] });
    expect(p.state().testLock?.commit).toBe(commit);
  }, 60_000);

  it('refuses a test that is green on the current code: it does not reproduce the bug (review focus 1)', async () => {
    const p = await project();
    const commit = p.commit(repro(p.goalId, 'case total pass'), 'repro');
    const result = await p.service.submit(p.goalId, commit, 'tester');
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('test không tái hiện lỗi');
    expect(p.state().testLock).toBeUndefined();
  }, 60_000);

  it('refuses a test that is red only because it did not load (review focus 2)', async () => {
    const p = await project();
    const commit = p.commit(repro(p.goalId, 'case total load'), 'repro');
    const result = await p.service.submit(p.goalId, commit, 'tester');
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/the test did not load: ImportError/);
  }, 60_000);

  it('refuses a Tester who changes the code to make the test red, a stub or test infrastructure', async () => {
    const p = await project();
    // The module "throws not implemented": a test of `add` is red, with no bug behind it.
    const swapped = p.commit(
      { ...repro(p.goalId, 'case total needs add'), 'src/impl.txt': 'nothing\n' },
      'repro that swaps the module',
    );
    const swap = await p.service.submit(p.goalId, swapped, 'tester');
    expect(swap.ok).toBe(false);
    expect(swap.problems.join('\n')).toMatch(/src\/impl\.txt: bugfix: the Tester adds tests only/);
    const stub = await p.service.submit(
      p.goalId,
      p.commit({ ...repro(p.goalId), 'src/stub.txt': 'edited\n' }, 'repro that edits the stub'),
      'tester',
    );
    expect(stub.problems.join('\n')).toMatch(/src\/stub\.txt: bugfix: the Tester adds tests only/);
    const infra = await p.service.submit(
      p.goalId,
      p.commit({ ...repro(p.goalId), 'tests/infra.cfg': 'swallow\n' }, 'repro that swallows failures'),
      'tester',
    );
    expect(infra.problems.join('\n')).toMatch(/tests\/infra\.cfg: bugfix: the Tester adds tests only/);
    expect(p.state().testLock).toBeUndefined();
  }, 120_000);

  it('leaves an ordinary Goal as it was: a stub is allowed', async () => {
    const p = await testingProject({ files: { 'src/impl.txt': 'add\n' } });
    const commit = p.commit({ ...repro(p.goalId), 'src/stub.txt': 'stub\n' }, 'tests');
    expect((await p.service.submit(p.goalId, commit, 'tester')).ok).toBe(true);
  }, 60_000);
});
