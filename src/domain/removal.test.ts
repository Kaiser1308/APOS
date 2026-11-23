import { describe, expect, it } from 'vitest';
import { parseGoalSpec } from './contracts.js';
import { spec } from './fixtures.test-support.js';
import { entryMatches, removalEntries, removalProblems, removalOf } from './removal.js';

const removed = (removesTests: string[]) =>
  parseGoalSpec({
    ...spec,
    acceptance: [{ ...spec.acceptance[0]!, proof: 'removed', removesTests }],
  });

describe('removed criterion', () => {
  it('needs removesTests, and removesTests belong to a removed criterion only', () => {
    expect(() => parseGoalSpec({ ...spec, acceptance: [{ ...spec.acceptance[0]!, proof: 'removed' }] })).toThrow(
      /removesTests/,
    );
    expect(() =>
      parseGoalSpec({ ...spec, acceptance: [{ ...spec.acceptance[0]!, removesTests: ['app.L2::a::b'] }] }),
    ).toThrow(/removesTests/);
  });
  it('names each test as <part>.<layer>::<id>', () => {
    expect(() => removed(['tests.test_pricing::test_a'])).toThrow(/<part>\.<layer>::/);
    expect(removed(['app.L1::tests.test_pricing::test_a']).acceptance[0]!.removesTests).toHaveLength(1);
  });
  it('is allowed in a feature Goal, not in a bugfix, characterize or refactor one', () => {
    const base = removed(['app.L1::x']);
    for (const kind of ['bugfix', 'characterize', 'refactor'] as const)
      expect(() => parseGoalSpec({ ...base, kind, covers: ['a'], paths: ['a'], part: 'app' })).toThrow();
  });
  it('is what removalOf reads: every declared test of every removed criterion', () => {
    const goal = removed(['app.L1::a', 'app.L1::b']);
    expect(removalOf(goal)).toEqual([
      { acceptanceId: goal.acceptance[0]!.id, entry: 'app.L1::a' },
      { acceptanceId: goal.acceptance[0]!.id, entry: 'app.L1::b' },
    ]);
    expect(removalEntries(goal, ['NOPE'])).toEqual([]);
    expect(removalOf(parseGoalSpec(spec))).toEqual([]);
  });
});

describe('entryMatches', () => {
  it('matches one test, every test of a file, a repeated id and a parametrized one', () => {
    expect(entryMatches('app.L1::t.f::a', 'app.L1::t.f::a')).toBe(true);
    expect(entryMatches('app.L1::t.f', 'app.L1::t.f::a')).toBe(true);
    expect(entryMatches('app.L1::t.f::a', 'app.L1::t.f::a#2')).toBe(true);
    expect(entryMatches('app.L1::t.f::a', 'app.L1::t.f::a[1-2]')).toBe(true);
  });
  it('does not match a neighbour', () => {
    expect(entryMatches('app.L1::t.f::a', 'app.L1::t.f::ab')).toBe(false);
    expect(entryMatches('app.L1::t.f', 'app.L1::t.fx::a')).toBe(false);
    expect(entryMatches('app.L1::t.f::a', 'app.L2::t.f::a')).toBe(false);
  });
});

describe('removalProblems', () => {
  it('lists every declared test the base does not have, and every layer it did not run', () => {
    const goal = removed(['app.L1::t.f::a', 'app.L1::t.g', 'web.L2::t.h::c']);
    const problems = removalProblems(goal, { 'app.L1': ['app.L1::t.f::a', 'app.L1::t.f::b'] });
    expect(problems.join('\n')).toMatch(/app\.L1::t\.g/);
    expect(problems.join('\n')).toMatch(/web\.L2::t\.h::c.*web\.L2/);
    expect(problems.join('\n')).not.toMatch(/t\.f::a/);
  });
  it('is empty when each declared test is on the base', () => {
    expect(removalProblems(removed(['app.L1::t.f']), { 'app.L1': ['app.L1::t.f::a'] })).toEqual([]);
  });
});
