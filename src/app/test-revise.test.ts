import { afterEach, describe, expect, it } from 'vitest';
import { ExceptionService } from './exceptions.js';
import { cleanProjects, ids, lockedProject, mapFor } from './test-lock.test-support.js';
import { buildInbox } from './inbox.js';

afterEach(cleanProjects);

/** A tester's revision is made from the lock commit, not from the worker's code, so it is red again. */
const revision = (p: Awaited<ReturnType<typeof lockedProject>>, files: Record<string, string | null>) => {
  p.git('checkout', '-q', '--detach', p.lockCommit);
  return p.commit(files, 'revise tests');
};
const tests = (p: { goalId: string }, calc: string, testIds = [ids.add]) => ({
  'tests/acceptance/calc.t': calc,
  [`.apos/goals/${p.goalId}/tests.json`]: mapFor(p.goalId, testIds),
});

describe('tests revise', () => {
  it('locks a stronger suite as a revision of the first lock, and every package is gated again on the new commit', async () => {
    const p = await lockedProject();
    const commit = revision(p, tests(p, 'case add needs add\ncase sub needs sub\n', [ids.add, ids.sub]));
    expect(await p.service.revise(p.goalId, commit, 'entry changed', 'tester')).toEqual({ ok: true, problems: [] });
    expect(p.state().testLock).toMatchObject({ commit, revisionOf: p.lockCommit, reason: 'entry changed' });
    expect(p.state().testLock?.asserts['tests/acceptance/calc.t']).toBe(2);
    // A package branched from the old lock can no longer be submitted.
    p.git('checkout', '-q', '-b', 'work', p.lockCommit);
    const old = p.commit({ 'src/impl.txt': 'add\nsub\n' }, 'work on the old lock');
    await expect(p.submit(old)).rejects.toThrow(/does not contain the commit that locked the tests/);
    p.git('merge', '-q', '--no-edit', commit);
    const merged = p.git('rev-parse', 'HEAD');
    expect((await p.submit(merged)).result).toBe('green');
  }, 240_000);

  it('treats a renamed locked test as a deleted one: it waits for an exception and is not locked by itself (review focus 4)', async () => {
    const p = await lockedProject();
    const commit = revision(p, tests(p, 'case plus needs add\n', ['tests.acceptance.calc::plus']));
    const outcome = await p.service.revise(p.goalId, commit, 'renamed add to plus', 'tester');
    expect(outcome.ok).toBe(false);
    expect(outcome.pending).toBe(true);
    expect(outcome.problems).toEqual(expect.arrayContaining([`locked test removed or renamed: app.L2::${ids.add}`]));
    expect(p.state().testLock?.commit).toBe(p.lockCommit);
    expect(p.state().pendingRevision).toMatchObject({ commit, reason: 'renamed add to plus' });
    expect(buildInbox(p.journal).map(item => JSON.parse(item.detail).why)).toContain('tests-revision-pending');
    // Asking again does not lock it, and does not pile up events.
    await p.service.revise(p.goalId, commit, 'renamed add to plus', 'tester');
    expect(p.journal.events(p.goalId).filter(item => item.type === 'tests-revision-pending')).toHaveLength(1);

    new ExceptionService(p.journal).approve(p.goalId, {
      kind: 'tests-weakened',
      ref: commit,
      reason: 'rename is fine',
      by: 'agent:lead',
    });
    expect(buildInbox(p.journal).map(item => JSON.parse(item.detail).why)).not.toContain('tests-revision-pending');
    expect((await p.service.revise(p.goalId, commit, 'renamed add to plus', 'tester')).ok).toBe(true);
    expect(p.state().testLock?.commit).toBe(commit);
    expect(p.state().pendingRevision).toBeUndefined();
  }, 240_000);

  it('waits for an exception when the number of asserts in a file falls, even though every test id is still there', async () => {
    const p = await lockedProject();
    const first = revision(p, tests(p, 'case add needs add\ncase add needs add\n'));
    await p.service.revise(p.goalId, first, 'more asserts', 'tester');
    expect(p.state().testLock?.asserts['tests/acceptance/calc.t']).toBe(2);
    p.git('checkout', '-q', '--detach', first);
    const weaker = p.commit(tests(p, 'case add needs add\n'), 'fewer asserts');
    const outcome = await p.service.revise(p.goalId, weaker, 'trim', 'tester');
    expect(outcome).toMatchObject({ ok: false, pending: true });
    expect(outcome.problems).toEqual(['tests/acceptance/calc.t: asserts fell from 2 to 1']);
  }, 240_000);

  it('waits when a criterion keeps fewer tests than before', async () => {
    const p = await lockedProject();
    const first = revision(p, tests(p, 'case add needs add\ncase sub needs sub\n', [ids.add, ids.sub]));
    await p.service.revise(p.goalId, first, 'two tests', 'tester');
    p.git('checkout', '-q', '--detach', first);
    // sub stays in the file but leaves the map.
    const fewer = p.commit(tests(p, 'case add needs add\ncase sub needs sub\n'), 'unmap sub');
    const outcome = await p.service.revise(p.goalId, fewer, 'unmap', 'tester');
    expect(outcome.problems).toEqual(
      expect.arrayContaining([
        `locked test removed or renamed: app.L2::${ids.sub}`,
        'AC-1 has fewer tests than before (1 < 2)',
      ]),
    );
  }, 240_000);

  it('refuses a revision that is green on the old code, one that does not contain the lock, and one that touches source', async () => {
    const p = await lockedProject();
    const green = revision(p, tests(p, 'case add pass\n'));
    expect((await p.service.revise(p.goalId, green, 'r', 'tester')).problems.join()).toMatch(/already green/);
    p.git('checkout', '-q', '--orphan', 'elsewhere');
    const orphan = p.commit({ ...tests(p, 'case add needs add\n'), 'x.txt': 'x' }, 'unrelated');
    expect((await p.service.revise(p.goalId, orphan, 'r', 'tester')).problems[0]).toMatch(
      /does not contain .* rebase onto it/,
    );
    p.git('checkout', '-q', '--detach', p.lockCommit);
    const source = p.commit({ ...tests(p, 'case add needs add\n'), 'src/impl.txt': 'add\n' }, 'touches source');
    expect((await p.service.revise(p.goalId, source, 'r', 'tester')).problems.join()).toMatch(
      /src\/impl\.txt: not a test file/,
    );
    expect(p.state().testLock?.commit).toBe(p.lockCommit);
  }, 240_000);

  it('re-locks a changed file with the same tests and asserts, with the new hash', async () => {
    const p = await lockedProject();
    const commit = revision(p, tests(p, 'case add needs add \n'));
    expect((await p.service.revise(p.goalId, commit, 'whitespace', 'tester')).ok).toBe(true);
    expect(p.state().testLock?.files['tests/acceptance/calc.t']).not.toBe(
      (await lockedProject()).state().testLock?.files['tests/acceptance/calc.t'],
    );
  }, 240_000);

  it('needs a reason', async () => {
    const p = await lockedProject();
    await expect(p.service.revise(p.goalId, p.lockCommit, ' ', 'tester')).rejects.toThrow(/--reason is required/);
  }, 120_000);
});
