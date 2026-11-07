import { describe, expect, it } from 'vitest';
import { parseExecutionProposal, parseGoalSpec } from './contracts.js';

const goal = {
  id: 'GOAL-001', version: 1, outcome: 'QR check-in works',
  scope: ['scan QR'], exclusions: ['dashboard'],
  acceptance: [{ id: 'AC-1', text: 'valid QR creates one check-in' }],
  appetite: '2 days', dependencies: [], priority: 1, autoMergeAuthorized: false
};

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
});

describe('Execution proposal contract', () => {
  const proposal = {
    id: 'EXEC-001', version: 1, goalId: 'GOAL-001', goalVersion: 1,
    mode: 'solo-direct', approach: 'reuse existing check-in API',
    risks: ['QR expiration'], acceptanceMapping: [{ acceptanceId: 'AC-1', verification: 'integration test' }],
    verificationStrategy: 'run acceptance and regression tests'
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
