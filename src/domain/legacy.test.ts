import { describe, expect, it } from 'vitest';
import {
  characterizations,
  characterizeProposal,
  coverageProblems,
  planPathProblems,
  refactorCoverage,
  type Characterization,
} from './legacy.js';
import { parseSetupObject } from './project-setup.js';
import type { GoalState } from './transitions.js';
import type { TestLock } from './test-lock.js';
import { spec } from './fixtures.test-support.js';

const lock = { commit: 'a'.repeat(40), files: {}, asserts: {}, map: [], by: 't' } as TestLock;
const state = (id: string, kind: string, status: string, covers?: string[]): GoalState =>
  ({
    spec: { ...spec, id, kind, ...(covers ? { covers } : {}) },
    status,
    selected: true,
    evidence: [],
    reviews: [],
    testLock: lock,
  }) as unknown as GoalState;

describe('characterizations', () => {
  it('takes only closed characterize Goals with a lock, in id order', () => {
    const goals = [
      state('GOAL-B', 'characterize', 'closed', ['b/**']),
      state('GOAL-A', 'characterize', 'closed', ['a/**']),
      state('GOAL-C', 'characterize', 'verified', ['c/**']),
      state('GOAL-D', 'feature', 'closed'),
      { ...state('GOAL-E', 'characterize', 'closed', ['e/**']), testLock: undefined } as GoalState,
    ];
    expect(characterizations(goals).map(item => item.goalId)).toEqual(['GOAL-A', 'GOAL-B']);
  });
});

describe('refactorCoverage', () => {
  const files = ['legacy/pricing.py', 'legacy/tax.py', 'legacy/util/io.py', 'other/x.py', 'README.md'];
  const covers = (goalId: string, ...globs: string[]): Characterization => ({ goalId, covers: globs, lock });
  it('is whole when every file the paths match matches some covers, and names the Goals that cover them', () => {
    const result = refactorCoverage({
      paths: ['legacy/*.py'],
      files,
      characterized: [
        covers('GOAL-A', 'legacy/pricing.py'),
        covers('GOAL-B', 'legacy/**'),
        covers('GOAL-C', 'other/**'),
      ],
    });
    expect(result.files).toEqual(['legacy/pricing.py', 'legacy/tax.py']);
    expect(result.uncovered).toEqual([]);
    expect(result.sources.map(item => item.goalId)).toEqual(['GOAL-A', 'GOAL-B']);
    expect(coverageProblems(result, 'HEAD')).toEqual([]);
  });
  it('names each file that no characterize Goal covers', () => {
    const result = refactorCoverage({
      paths: ['legacy/**'],
      files,
      characterized: [covers('GOAL-A', 'legacy/pricing.py')],
    });
    expect(result.uncovered).toEqual(['legacy/tax.py', 'legacy/util/io.py']);
    expect(coverageProblems(result, 'HEAD')[0]).toContain('legacy/tax.py, legacy/util/io.py');
  });
  it('names a glob that matches no file, so a typo does not pass for nothing to cover', () => {
    const result = refactorCoverage({ paths: ['legcy/**'], files, characterized: [covers('GOAL-A', 'legacy/**')] });
    expect(coverageProblems(result, 'abc1234')).toEqual([
      expect.stringContaining('paths "legcy/**" matches no file at abc1234'),
    ]);
  });
  it('does not accept a Goal that is not closed or has no lock: none is given', () => {
    const result = refactorCoverage({ paths: ['legacy/**'], files, characterized: [] });
    expect(result.uncovered.length).toBe(3);
  });
});

describe('planPathProblems', () => {
  const files = ['legacy/a.py', 'legacy/b.py', 'other/c.py'];
  it('allows the Goal paths and globs inside them, and refuses one that reaches past', () => {
    expect(planPathProblems({ plan: ['legacy/**'], goalPaths: ['legacy/**'], files })).toEqual([]);
    expect(planPathProblems({ plan: ['legacy/a.py'], goalPaths: ['legacy/**'], files })).toEqual([]);
    expect(planPathProblems({ plan: ['**'], goalPaths: ['legacy/**'], files })).toEqual([
      expect.stringContaining('other/c.py'),
    ]);
    expect(planPathProblems({ plan: ['nowhere/**'], goalPaths: ['legacy/**'], files })).toEqual([
      expect.stringContaining('matches no file'),
    ]);
  });
});

describe('characterizeProposal', () => {
  const setup = parseSetupObject({
    schemaVersion: 2,
    parts: {
      app: {
        root: 'svc',
        layers: {},
        tests: { paths: ['tests/**'], assertPatterns: [], notImplementedPatterns: [], loadErrorPatterns: [] },
      },
    },
  });
  it('is a Solo plan whose package may change test files only, mapping each criterion to a locked stays-green test', () => {
    const goal = { ...spec, kind: 'characterize' as const, covers: ['svc/pricing.py'] };
    const plan = characterizeProposal({
      goal,
      version: 1,
      baseCommit: 'b'.repeat(40),
      setup: setup.version === 2 ? setup.setup : undefined,
    });
    expect(plan).toMatchObject({ mode: 'solo-direct', goalId: spec.id, paths: ['svc/tests/**'] });
    expect(plan.stubPaths).toBeUndefined();
    expect(plan.acceptanceMapping.map(item => item.acceptanceId)).toEqual(['AC-1']);
  });
});
