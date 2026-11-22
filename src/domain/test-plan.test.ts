import { describe, expect, it } from 'vitest';
import { parseGoalSpec, parseExecutionProposal } from './contracts.js';
import { parseWorkPackage } from './packages.js';
import { acceptanceProof, testPlanProblems } from './test-plan.js';
import { proposal, spec } from './fixtures.test-support.js';

const criterion = (id: string, extra: object = {}) => ({
  id,
  text: id,
  requirementIds: ['R-1'],
  checkIds: ['CHK-1'],
  ...extra,
});
const goal = (acceptance: object[]) => parseGoalSpec({ ...spec, acceptance });
const wp = (id: string, goalAcceptanceId: string, extra: object = {}) =>
  parseWorkPackage({
    id,
    goalId: 'GOAL-001',
    goalVersion: 1,
    version: 1,
    owner: 'w',
    outcome: 'o',
    scope: ['s'],
    exclusions: [],
    dependencies: [],
    interfaces: ['api@v1'],
    acceptance: [{ id: `${id}-AC`, text: 't', goalAcceptanceId }],
    integration: 'i',
    ...extra,
  });
const multi = parseExecutionProposal({ ...proposal, mode: 'multi-wp', splitRationale: 'x' });

describe('acceptance proof and test-plan contract', () => {
  it('defaults a criterion to red-green and keeps given/when/then', () => {
    const [plain, manual] = goal([
      criterion('AC-1', { given: 'a code', when: 'scanned', then: 'one check-in' }),
      criterion('AC-2', { proof: 'manual' }),
    ]).acceptance;
    expect(acceptanceProof(plain!)).toBe('red-green');
    expect(plain).toMatchObject({ given: 'a code', when: 'scanned', then: 'one check-in' });
    expect(acceptanceProof(manual!)).toBe('manual');
  });
  it('refuses an unknown proof kind (benchmark and scan arrive in phase 4)', () => {
    expect(() => goal([criterion('AC-1', { proof: 'benchmark' })])).toThrow();
  });
  it('still parses a package and a proposal written before phase 3', () => {
    expect(wp('WP-01', 'AC-1').paths).toBeUndefined();
    expect(parseExecutionProposal(proposal).paths).toBeUndefined();
  });
  it('rejects empty paths', () => {
    expect(() => wp('WP-01', 'AC-1', { paths: [] })).toThrow();
  });

  it('asks every Multi-WP criterion needing a test to belong to exactly one package', () => {
    const g = goal([criterion('AC-1'), criterion('AC-2'), criterion('AC-3', { proof: 'manual' })]);
    const problems = testPlanProblems({
      goal: g,
      proposal: multi,
      packages: [wp('WP-01', 'AC-1', { paths: ['a/**'] }), wp('WP-02', 'AC-1', { paths: ['b/**'] })],
      pinned: false,
    });
    expect(problems).toEqual([
      'AC-1 belongs to 2 packages (WP-01, WP-02): a criterion that needs a test belongs to exactly one',
      'AC-2 belongs to no package: a criterion that needs a test belongs to exactly one',
    ]);
  });
  it('wants a shared path listed in sharedPaths when two packages overlap', () => {
    const g = goal([criterion('AC-1'), criterion('AC-2')]);
    const packages = [wp('WP-01', 'AC-1', { paths: ['src/**'] }), wp('WP-02', 'AC-2', { paths: ['src/api/**'] })];
    expect(testPlanProblems({ goal: g, proposal: multi, packages, pinned: true })).toEqual([
      'WP-01 and WP-02 both claim src/api/**: list it in sharedPaths or split the paths',
    ]);
    expect(
      testPlanProblems({
        goal: g,
        proposal: { ...multi, sharedPaths: ['src/api/**'] },
        packages,
        pinned: true,
      }),
    ).toEqual([]);
  });
  it('asks a Goal pinned to a setup for paths on the Solo plan and on each package', () => {
    const g = goal([criterion('AC-1')]);
    expect(testPlanProblems({ goal: g, proposal, packages: [], pinned: true })).toEqual([
      'proposal.paths is required: the gate needs to know which files the package may change',
    ]);
    expect(
      testPlanProblems({ goal: g, proposal: { ...proposal, paths: ['src/**'] }, packages: [], pinned: true }),
    ).toEqual([]);
    expect(testPlanProblems({ goal: g, proposal, packages: [], pinned: false })).toEqual([]);
    expect(
      testPlanProblems({
        goal: g,
        proposal: multi,
        packages: [wp('WP-01', 'AC-1'), wp('WP-02', 'AC-9')],
        pinned: true,
      }),
    ).toContain('WP-01 has no paths: the gate needs to know which files the package may change');
  });
});
