import type { GoalSpec, ExecutionProposal } from './contracts.js';

export const spec: GoalSpec = {
  id: 'GOAL-001', version: 1, outcome: 'check in', scope: ['QR'], exclusions: [],
  acceptance: [{ id: 'AC-1', text: 'valid QR works' }], appetite: '2 days',
  dependencies: [], priority: 1, autoMergeAuthorized: false
};
export const proposal: ExecutionProposal = {
  id: 'EXEC-001', version: 1, goalId: spec.id, goalVersion: 1,
  mode: 'solo-direct', approach: 'reuse API', risks: [],
  acceptanceMapping: [{ acceptanceId: 'AC-1', verification: 'test' }],
  verificationStrategy: 'integration test'
};
