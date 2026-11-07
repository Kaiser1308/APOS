import { randomUUID } from 'node:crypto';
import type { Evidence, GoalId } from '../domain/contracts.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { SqliteStore } from '../store/sqlite.js';

export type VerificationResult = { passed: true; acceptanceIds: string[] };

export class VerificationService {
  constructor(private readonly store: SqliteStore) {}

  private record(goalId: GoalId, type: GoalEventType, data?: unknown): void {
    this.store.append({ id: randomUUID(), goalId, type, data, at: new Date().toISOString() });
  }

  submitEvidence(goalId: GoalId, evidence: Evidence): void {
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing') throw new Error('Goal must be executing to receive evidence');
    if (!state.spec.acceptance.some(item => item.id === evidence.acceptanceId)) throw new Error(`Unknown acceptance ID: ${evidence.acceptanceId}`);
    if ((evidence.result !== 'pass' && evidence.result !== 'fail') || !evidence.command?.trim() || !evidence.artifactRef?.trim()) throw new Error('Evidence requires result, command and artifact reference');
    this.record(goalId, 'evidence-submitted', evidence);
  }

  verify(goalId: GoalId): VerificationResult {
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing') throw new Error('Goal must be executing to verify');
    const latest = new Map<string, Evidence>();
    for (const item of state.evidence) {
      const evidence = item as Evidence;
      latest.set(evidence.acceptanceId, evidence);
    }
    const missing = state.spec.acceptance.filter(item => latest.get(item.id)?.result !== 'pass').map(item => item.id);
    if (missing.length) throw new Error(`Acceptance evidence missing or failing: ${missing.join(', ')}`);
    this.record(goalId, 'verified', { acceptanceIds: state.spec.acceptance.map(item => item.id) });
    return { passed: true, acceptanceIds: state.spec.acceptance.map(item => item.id) };
  }

  recordOutcome(goalId: GoalId, decision: 'close' | 'revise' | 'stop'): void {
    const type = { close: 'outcome-accepted', revise: 'outcome-revised', stop: 'outcome-stopped' } as const;
    this.record(goalId, type[decision]);
  }

  mayAutoMerge(goalId: GoalId): boolean {
    const state = this.store.getGoal(goalId);
    return Boolean(state?.spec.autoMergeAuthorized && state.status === 'verified');
  }
}
