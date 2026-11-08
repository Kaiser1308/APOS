import type { GoalSpec, ExecutionProposal } from './contracts.js';
import { sourceDigest, type GateReport } from './gate.js';

export const sourceText = '# QR check-in\n\nA valid QR code creates exactly one check-in.\n';
export const spec: GoalSpec = {
  id: 'GOAL-001', version: 1, outcome: 'check in',
  source: { path: 'docs/brief.md', sha256: sourceDigest(sourceText), capturedAt: '2026-11-07T00:00:00.000Z', origin: 'human' },
  requirements: [{ id: 'R-1', sourceSpan: 'line 3', text: 'valid QR creates one check-in', disposition: 'acceptance' }],
  scope: ['QR'], exclusions: [],
  acceptance: [{ id: 'AC-1', text: 'valid QR works', requirementIds: ['R-1'], examples: [], boundaries: [], prohibited: [], checkIds: ['CHK-1'] }],
  checks: [{ id: 'CHK-1', kind: 'command', command: 'npm test', expect: 'pass', runs: 1, timeoutMs: 600_000, env: {} }],
  dependencies: [], priority: 1
};
/** Data of a `goal-approved` event: the Human approves the Goal together with its controller-only appetite. */
export const approval = { appetite: { size: 'M', maxSpendUsd: 20, maxWallMinutes: 240, maxAttempts: 3, overrunPolicy: 'ask' } } as const;
export const proposal: ExecutionProposal = {
  id: 'EXEC-001', version: 1, goalId: spec.id, goalVersion: 1,
  mode: 'solo-direct', approach: 'reuse API', risks: [], sharedPaths: [],
  splitRationale: 'scanner and history change separate modules', estimatedCost: { spendUsd: 5, wallMinutes: 60 },
  acceptanceMapping: [{ acceptanceId: 'AC-1', verification: 'test' }],
  verificationStrategy: 'integration test'
};
export const BASE = 'b'.repeat(40);
export const DELIVERY = 'a'.repeat(40);
/** A controller gate report as GateService would record it, for tests that do not run commands. */
export const gateReport = (deliveryCommit: string = DELIVERY, result: GateReport['result'] = 'green', goal: GoalSpec = spec): GateReport => ({
  gateId: 'GATE-test', goalId: goal.id, goalVersion: goal.version, sourceSha256: goal.source.sha256,
  baseCommit: BASE, deliveryCommit, attemptKey: 'solo:-:1', environment: { platform: 'test', shell: 'sh', node: 'v0' },
  checks: goal.checks.map(check => ({ checkId: check.id, status: result === 'green' ? 'pass' : 'fail', reason: 'fixture', base: [], delivery: [], newFailures: [] })),
  result, at: '2026-11-07T00:00:00.000Z'
});
