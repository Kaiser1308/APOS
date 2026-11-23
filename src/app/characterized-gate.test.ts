import { afterEach, describe, expect, it } from 'vitest';
import { coverageOfRefactor } from './characterized-gate.js';
import { GitCommitInspector } from './integration.js';
import { cleanProjects, testingProject } from './test-lock.test-support.js';
import type { GoalState } from '../domain/transitions.js';
import type { TestLock } from '../domain/test-lock.js';
import { spec } from '../domain/fixtures.test-support.js';

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
