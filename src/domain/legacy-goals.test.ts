import { describe, expect, it } from 'vitest';
import { goalApprovalBlockers, goalKind, isSketchGoal, parseExecutionProposal, parseGoalSpec } from './contracts.js';
import { buildPlan } from './plan.js';
import { proposal, spec } from './fixtures.test-support.js';
import type { GoalState } from './transitions.js';

const characterize = { ...spec, kind: 'characterize', covers: ['src/pricing.py'] };
const refactor = {
  ...spec,
  kind: 'refactor',
  paths: ['src/pricing.py'],
  requirements: [{ id: 'R-1', sourceSpan: 'line 1', text: 'split pricing', disposition: 'acceptance' }],
  acceptance: [],
  checks: [],
};

describe('a characterize Goal', () => {
  it('says which code it captures, and its criteria are stays-green without writing so', () => {
    const goal = parseGoalSpec(characterize);
    expect(goalKind(goal)).toBe('characterize');
    expect(goal.covers).toEqual(['src/pricing.py']);
    expect(goal.acceptance.map(item => item.proof)).toEqual(['stays-green']);
    expect(
      parseGoalSpec({ ...characterize, acceptance: [{ ...spec.acceptance[0], proof: 'stays-green' }] }).acceptance[0]
        ?.proof,
    ).toBe('stays-green');
  });
  it('refuses any other proof at creation, and a Goal with no covers', () => {
    for (const proof of ['red-green', 'manual', 'benchmark', 'scan'])
      expect(() => parseGoalSpec({ ...characterize, acceptance: [{ ...spec.acceptance[0], proof }] }), proof).toThrow(
        /characterize criterion is proved by a test that is green/,
      );
    expect(() => parseGoalSpec({ ...characterize, covers: undefined })).toThrow(/covers is required/);
    expect(() => parseGoalSpec({ ...characterize, covers: [] })).toThrow();
  });
  it('is no longer a feature: covers and paths belong to their kinds only', () => {
    expect(() => parseGoalSpec({ ...spec, covers: ['a'] })).toThrow(/covers belongs to a characterize Goal/);
    expect(() => parseGoalSpec({ ...characterize, paths: ['a'] })).toThrow(/paths belongs to a refactor Goal/);
  });
  it('leaves a feature Goal alone: its proof stays unset', () => {
    expect(parseGoalSpec(spec).acceptance[0]?.proof).toBeUndefined();
  });
});

describe('a refactor Goal', () => {
  it('says which code it restructures, and needs no criterion or check of its own', () => {
    const goal = parseGoalSpec(refactor);
    expect(goalKind(goal)).toBe('refactor');
    expect(goal.paths).toEqual(['src/pricing.py']);
    expect(isSketchGoal(goal)).toBe(false);
    expect(goalApprovalBlockers(goal)).toEqual([]);
    expect(() => parseGoalSpec({ ...refactor, paths: undefined })).toThrow(/paths is required/);
  });
  it('allows only stays-green criteria when it has any', () => {
    const own = { ...spec.acceptance[0], proof: 'red-green' };
    expect(() => parseGoalSpec({ ...refactor, acceptance: [own], checks: spec.checks })).toThrow(
      /adds no new behaviour: its criteria are stays-green/,
    );
    const stays = parseGoalSpec({ ...refactor, acceptance: [spec.acceptance[0]], checks: spec.checks });
    expect(stays.acceptance[0]?.proof).toBe('stays-green');
  });
  it('still needs its requirements covered when it does have criteria', () => {
    const goal = parseGoalSpec({
      ...refactor,
      requirements: [
        ...refactor.requirements,
        { id: 'R-2', sourceSpan: 'line 2', text: 'x', disposition: 'acceptance' },
      ],
      acceptance: [spec.acceptance[0]],
      checks: spec.checks,
    });
    expect(goalApprovalBlockers(goal)).toEqual(['Requirement R-2 has no acceptance criterion']);
  });
  it('leaves other Goals as they were: a Goal with no criteria is still a sketch', () => {
    const sketch = parseGoalSpec({ ...spec, acceptance: [], checks: [] });
    expect(isSketchGoal(sketch)).toBe(true);
    expect(goalApprovalBlockers(sketch)[0]).toContain('is a sketch');
  });
  it('shows in the plan as a Goal, not as a sketch', () => {
    const state = { spec: parseGoalSpec(refactor), status: 'draft' } as unknown as GoalState;
    expect(buildPlan([state]).goals[0]).toMatchObject({ id: spec.id, sketch: false });
  });
  it('has a plan with no criterion to map', () => {
    expect(parseExecutionProposal({ ...proposal, acceptanceMapping: [] }).acceptanceMapping).toEqual([]);
  });
});
