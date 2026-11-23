import { afterEach, describe, expect, it } from 'vitest';
import { coverageOfRefactor } from './characterized-gate.js';
import { GitCommitInspector } from './integration.js';
import { cleanProjects, testingProject } from './test-lock.test-support.js';
import type { GoalState } from '../domain/transitions.js';
import type { TestLock } from '../domain/test-lock.js';
import { spec } from '../domain/fixtures.test-support.js';
import { sha256Of } from './git-files.js';

afterEach(cleanProjects);

const closed = (id: string, commit: string): GoalState =>
  ({
    spec: { ...spec, id, kind: 'characterize', covers: ['src/legacy.txt'] },
    status: 'closed',
    selected: true,
    evidence: [],
    reviews: [],
    testLock: { commit, files: {}, asserts: {}, map: [], by: 't' } as TestLock,
  }) as unknown as GoalState;

describe('coverageOfRefactor', () => {
  it('counts only the characterize Goals whose tests the plan base holds, so a later one cannot turn a plan red', async () => {
    const p = await testingProject({ files: { 'src/legacy.txt': 'legacy\n' } });
    const early = closed('GOAL-EARLY', p.base);
    const late = closed('GOAL-LATE', 'f'.repeat(40));
    const refactor = {
      ...early,
      spec: { ...spec, id: 'GOAL-R', kind: 'refactor', paths: ['src/legacy.txt'] },
      status: 'executing',
      testLock: undefined,
      proposal: { baseCommit: p.base },
    } as unknown as GoalState;
    const holds = {
      exists: () => true,
      files: () => [],
      contains: (_repo: string, ancestor: string) => ancestor === p.base,
    };
    expect(coverageOfRefactor(p.dir, [early, late, refactor], refactor).sources.map(item => item.goalId)).toEqual([
      'GOAL-EARLY',
      'GOAL-LATE',
    ]);
    const atTheGate = coverageOfRefactor(p.dir, [early, late, refactor], refactor, undefined, holds);
    expect(atTheGate.sources.map(item => item.goalId)).toEqual(['GOAL-EARLY']);
  }, 60_000);

  it('orders the sources from the oldest lock to the newest, whatever the Goal ids say', async () => {
    const p = await testingProject({ files: { 'src/legacy.txt': 'legacy\n' } });
    const older = p.commit({ 'tests/a.t': 'case a pass\n' }, 'first lock');
    const newer = p.commit({ 'tests/a.t': 'case a pass\ncase b pass\n' }, 'second lock');
    // GOAL-A has the later lock: by id it comes first, by history it comes last.
    const a = closed('GOAL-A', newer);
    const b = closed('GOAL-B', older);
    const refactor = {
      ...a,
      spec: { ...spec, id: 'GOAL-R', kind: 'refactor', paths: ['src/legacy.txt'] },
      status: 'executing',
      testLock: undefined,
      proposal: { baseCommit: newer },
    } as unknown as GoalState;
    const sources = coverageOfRefactor(p.dir, [a, b, refactor], refactor, undefined, new GitCommitInspector()).sources;
    expect(sources.map(item => item.goalId)).toEqual(['GOAL-B', 'GOAL-A']);
  }, 60_000);
});

describe('coverageOfRefactor after a Goal that removed tests (Review Focus 5)', () => {
  const lockOf = (commit: string, files: Record<string, string>): TestLock =>
    ({
      commit,
      files,
      asserts: {},
      map: [{ acceptanceId: 'AC-1', part: 'app', layer: 'L1', testIds: ['tests.a::one', 'tests.a::two'] }],
      by: 't',
    }) as TestLock;
  const removal = (verifiedCommit: string, changedFiles: string[], removesTests: string[]): GoalState =>
    ({
      spec: {
        ...spec,
        id: 'GOAL-GONE',
        acceptance: [{ ...spec.acceptance[0]!, proof: 'removed', removesTests }],
      },
      status: 'closed',
      selected: true,
      evidence: [],
      reviews: [],
      verifiedCommit,
      gate: { changedFiles },
    }) as unknown as GoalState;
  const refactorOf = (base: string): GoalState =>
    ({
      spec: { ...spec, id: 'GOAL-R', kind: 'refactor', paths: ['src/legacy.txt'] },
      status: 'executing',
      proposal: { baseCommit: base },
    }) as unknown as GoalState;

  it('no longer asks for the removed tests, and holds the file as the removal left it', async () => {
    const p = await testingProject({ files: { 'src/legacy.txt': 'legacy\n' } });
    const locked = p.commit({ 'tests/a.t': 'case one pass\ncase two pass\n' }, 'lock');
    const characterize = closed('GOAL-C', locked);
    characterize.testLock = lockOf(locked, { 'tests/a.t': sha256Of(Buffer.from('case one pass\ncase two pass\n')) });
    const after = p.commit({ 'tests/a.t': 'case one pass\n' }, 'remove two');
    const goals = [characterize, removal(after, ['tests/a.t'], ['app.L1::tests.a::two']), refactorOf(after)];
    const [source] = coverageOfRefactor(p.dir, goals, goals[2]!, undefined, new GitCommitInspector()).sources;
    expect(source?.lock.map[0]?.testIds).toEqual(['tests.a::one']);
    expect(source?.lock.files['tests/a.t']).toBe(sha256Of(Buffer.from('case one pass\n')));
  }, 60_000);

  it('drops a locked file the removal deleted, and leaves a removal older than the lock alone', async () => {
    const p = await testingProject({ files: { 'src/legacy.txt': 'legacy\n' } });
    const earlier = p.commit({ 'tests/a.t': 'case one pass\ncase two pass\n' }, 'before the lock');
    const locked = p.commit({ 'tests/b.t': 'case x pass\n' }, 'lock');
    const hash = sha256Of(Buffer.from('case one pass\ncase two pass\n'));
    const characterize = closed('GOAL-C', locked);
    characterize.testLock = lockOf(locked, { 'tests/a.t': hash });
    const refactor = refactorOf(locked);
    const old = coverageOfRefactor(
      p.dir,
      [characterize, removal(earlier, ['tests/a.t'], ['app.L1::tests.a::two']), refactor],
      refactor,
      undefined,
      new GitCommitInspector(),
    );
    expect(old.sources[0]?.lock.map[0]?.testIds).toEqual(['tests.a::one', 'tests.a::two']);
    const gone = p.commit({ 'tests/a.t': null }, 'delete the file');
    const later = coverageOfRefactor(
      p.dir,
      [characterize, removal(gone, ['tests/a.t'], ['app.L1::tests.a']), refactorOf(gone)],
      refactorOf(gone),
      undefined,
      new GitCommitInspector(),
    );
    expect(later.sources[0]?.lock.files).toEqual({});
    expect(later.sources[0]?.lock.map).toEqual([]);
  }, 60_000);

  it('leaves a lock alone when the removal took none of its tests, even if it edited the file', async () => {
    const p = await testingProject({ files: { 'src/legacy.txt': 'legacy\n' } });
    const locked = p.commit({ 'tests/a.t': 'case one pass\ncase two pass\n' }, 'lock');
    const hash = sha256Of(Buffer.from('case one pass\ncase two pass\n'));
    const characterize = closed('GOAL-C', locked);
    characterize.testLock = lockOf(locked, { 'tests/a.t': hash });
    const weakened = p.commit({ 'tests/a.t': 'case one pass\ncase two pass\n# weaker\n' }, 'edits a kept test');
    const goals = [characterize, removal(weakened, ['tests/a.t'], ['app.L1::tests.other::x']), refactorOf(weakened)];
    const [source] = coverageOfRefactor(p.dir, goals, goals[2]!, undefined, new GitCommitInspector()).sources;
    expect(source?.lock.files['tests/a.t']).toBe(hash);
    expect(source?.lock.map[0]?.testIds).toEqual(['tests.a::one', 'tests.a::two']);
  }, 60_000);

  it('ignores a removal the refactor base does not contain (Codex: limit to commits present on the base)', async () => {
    const p = await testingProject({ files: { 'src/legacy.txt': 'legacy\n' } });
    const locked = p.commit({ 'tests/a.t': 'case one pass\ncase two pass\n' }, 'lock');
    const characterize = closed('GOAL-C', locked);
    characterize.testLock = lockOf(locked, { 'tests/a.t': sha256Of(Buffer.from('case one pass\ncase two pass\n')) });
    const refactor = refactorOf(locked);
    const later = p.commit({ 'tests/a.t': 'case one pass\n' }, 'a removal that lands after the refactor base');
    const goals = [characterize, removal(later, ['tests/a.t'], ['app.L1::tests.a::two']), refactor];
    const [source] = coverageOfRefactor(p.dir, goals, refactor, undefined, new GitCommitInspector()).sources;
    expect(source?.lock.map[0]?.testIds).toEqual(['tests.a::one', 'tests.a::two']);
    // The same removal, once the base holds it, counts.
    const after = coverageOfRefactor(p.dir, goals, refactorOf(later), undefined, new GitCommitInspector()).sources;
    expect(after[0]?.lock.map[0]?.testIds).toEqual(['tests.a::one']);
  }, 60_000);

  it('applies removals in the order of their commits, not of their Goal ids (Codex)', async () => {
    const p = await testingProject({ files: { 'src/legacy.txt': 'legacy\n' } });
    const three = 'case one pass\ncase two pass\ncase three pass\n';
    const locked = p.commit({ 'tests/a.t': three }, 'lock');
    const characterize = closed('GOAL-C', locked);
    characterize.testLock = lockOf(locked, { 'tests/a.t': sha256Of(Buffer.from(three)) });
    characterize.testLock.map = [
      { acceptanceId: 'AC-1', part: 'app', layer: 'L1', testIds: ['tests.a::one', 'tests.a::two', 'tests.a::three'] },
    ];
    const first = p.commit({ 'tests/a.t': 'case one pass\ncase three pass\n' }, 'removes two');
    const second = p.commit({ 'tests/a.t': 'case one pass\n' }, 'removes three');
    // The later removal has the smaller Goal id.
    const early = {
      ...removal(second, ['tests/a.t'], ['app.L1::tests.a::three']),
      spec: {
        ...removal(second, [], ['x']).spec,
        id: 'GOAL-A-GONE',
        acceptance: [{ ...spec.acceptance[0]!, proof: 'removed', removesTests: ['app.L1::tests.a::three'] }],
      },
    } as GoalState;
    const late = {
      ...removal(first, ['tests/a.t'], ['app.L1::tests.a::two']),
      spec: {
        ...removal(first, [], ['x']).spec,
        id: 'GOAL-B-GONE',
        acceptance: [{ ...spec.acceptance[0]!, proof: 'removed', removesTests: ['app.L1::tests.a::two'] }],
      },
    } as GoalState;
    const goals = [characterize, early, late, refactorOf(second)];
    const [source] = coverageOfRefactor(p.dir, goals, goals[3]!, undefined, new GitCommitInspector()).sources;
    expect(source?.lock.map[0]?.testIds).toEqual(['tests.a::one']);
    expect(source?.lock.files['tests/a.t']).toBe(sha256Of(Buffer.from('case one pass\n')));
  }, 60_000);
});
