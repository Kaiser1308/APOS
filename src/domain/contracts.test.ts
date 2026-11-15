import { describe, expect, it } from 'vitest';
import { goalApprovalBlockers, parseExecutionProposal, parseGoalSpec } from './contracts.js';
import { spec } from './fixtures.test-support.js';

const goal = spec;

describe('Goal contract', () => {
  it('accepts a concrete Goal', () => {
    expect(parseGoalSpec(goal).id).toBe('GOAL-001');
  });
  it('rejects missing acceptance', () => {
    expect(() => parseGoalSpec({ ...goal, acceptance: [] })).toThrow();
  });
  it('rejects duplicate acceptance IDs', () => {
    expect(() => parseGoalSpec({ ...goal, acceptance: [goal.acceptance[0], goal.acceptance[0]] })).toThrow();
  });
  it('requires a source snapshot with a sha256', () => {
    expect(() => parseGoalSpec({ ...goal, source: undefined })).toThrow();
    expect(() => parseGoalSpec({ ...goal, source: { ...goal.source, sha256: 'abc' } })).toThrow();
  });
  it('rejects acceptance that names an unknown requirement or check', () => {
    expect(() => parseGoalSpec({ ...goal, acceptance: [{ ...goal.acceptance[0], requirementIds: ['R-9'] }] })).toThrow(
      /unknown requirement R-9/,
    );
    expect(() => parseGoalSpec({ ...goal, acceptance: [{ ...goal.acceptance[0], checkIds: ['CHK-9'] }] })).toThrow(
      /unknown check CHK-9/,
    );
  });
  it('rejects acceptance without a check', () => {
    expect(() => parseGoalSpec({ ...goal, acceptance: [{ ...goal.acceptance[0], checkIds: [] }] })).toThrow();
  });
  it('requires a reason to exclude a requirement and forbids accepting an excluded one', () => {
    const excluded = { ...goal.requirements[0], disposition: 'excluded' as const };
    expect(() => parseGoalSpec({ ...goal, requirements: [excluded] })).toThrow(/needs a reason/);
    expect(() => parseGoalSpec({ ...goal, requirements: [{ ...excluded, exclusionReason: 'later Goal' }] })).toThrow(
      /excluded requirement R-1/,
    );
  });
  it('requires a failure pattern to compare base and delivery failures', () => {
    const check = { id: 'CHK-1', kind: 'command', command: 'npm test', expect: 'no-new-failures' };
    expect(() => parseGoalSpec({ ...goal, checks: [check] })).toThrow(/failurePattern/);
    expect(parseGoalSpec({ ...goal, checks: [{ ...check, failurePattern: '^FAIL (\S+)' }] }).checks[0]).toMatchObject({
      runs: 1,
    });
  });
});

describe('Goal approval readiness', () => {
  it('blocks a requirement that no acceptance covers', () => {
    const orphan = { id: 'R-2', sourceSpan: 'line 5', text: 'reject expired QR', disposition: 'acceptance' as const };
    expect(goalApprovalBlockers(parseGoalSpec({ ...goal, requirements: [...goal.requirements, orphan] }))).toEqual([
      'Requirement R-2 has no acceptance criterion',
    ]);
  });
  it('blocks an acceptance criterion with an open question', () => {
    const blocked = {
      ...goal.acceptance[0],
      ambiguity: { status: 'blocked' as const, question: 'Does a reused QR count?' },
    };
    expect(goalApprovalBlockers(parseGoalSpec({ ...goal, acceptance: [blocked] }))[0]).toMatch(/open question/);
  });
  it('accepts a fully mapped Goal', () => {
    expect(goalApprovalBlockers(goal)).toEqual([]);
  });
});

describe('Execution proposal contract', () => {
  const proposal = {
    id: 'EXEC-001',
    version: 1,
    goalId: 'GOAL-001',
    goalVersion: 1,
    mode: 'solo-direct',
    approach: 'reuse existing check-in API',
    risks: ['QR expiration'],
    acceptanceMapping: [{ acceptanceId: 'AC-1', verification: 'integration test' }],
    verificationStrategy: 'run acceptance and regression tests',
  };
  it('accepts a Solo proposal', () => {
    expect(parseExecutionProposal(proposal).mode).toBe('solo-direct');
  });
  it('rejects invalid mode', () => {
    expect(() => parseExecutionProposal({ ...proposal, mode: 'split-by-layer' })).toThrow();
  });
  it('rejects invalid version', () => {
    expect(() => parseExecutionProposal({ ...proposal, goalVersion: 0 })).toThrow();
  });
});
