import { randomUUID } from 'node:crypto';
import type { Evidence, GoalId } from '../domain/contracts.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { GoalRepository } from '../store/journal.js';
import { requiresIndependentReview } from '../domain/reviews.js';
import { gateShortfalls } from '../domain/gate.js';

export type VerificationResult = { passed: true; acceptanceIds: string[]; deliveryCommit: string };

export class VerificationService {
  constructor(private readonly store: GoalRepository) {}

  private record(goalId: GoalId, type: GoalEventType, data?: unknown): void {
    this.store.append({ id: randomUUID(), goalId, type, data, at: new Date().toISOString() });
  }

  submitEvidence(goalId: GoalId, evidence: Evidence): void {
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing') throw new Error('Goal must be executing to receive evidence');
    if (!state.spec.acceptance.some(item => item.id === evidence.acceptanceId))
      throw new Error(`Unknown acceptance ID: ${evidence.acceptanceId}`);
    if (
      (evidence.result !== 'pass' && evidence.result !== 'fail') ||
      !evidence.command?.trim() ||
      !evidence.artifactRef?.trim()
    )
      throw new Error('Evidence requires result, command and artifact reference');
    this.record(goalId, 'evidence-submitted', evidence);
  }

  /**
   * Owner-submitted evidence is a report, not proof. A Goal verifies only on a green controller gate whose
   * delivery commit is the one under review (the integration commit for Multi-WP).
   */
  verify(goalId: GoalId, deliveryCommit?: string): VerificationResult {
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing') throw new Error('Goal must be executing to verify');
    const expected = state.proposal?.mode === 'multi-wp' ? state.integration?.commitRef : deliveryCommit;
    if (state.proposal?.mode === 'multi-wp' && !expected)
      throw new Error('Integrated Multi-WP commit required before verification');
    const problems = gateShortfalls(state.spec, state.gate, expected);
    if (problems.length) throw new Error(`Controller gate does not verify ${goalId}: ${problems.join('; ')}`);
    const gated = state.gate!.deliveryCommit;
    if (requiresIndependentReview(state)) {
      const review = [...state.reviews].reverse().find(item => item.subject === 'goal');
      if (review?.result !== 'pass' || review.commitRef.toLowerCase() !== gated.toLowerCase())
        throw new Error('Passing independent Goal review of the gated delivery commit required');
    }
    this.record(goalId, 'verified', {
      acceptanceIds: state.spec.acceptance.map(item => item.id),
      gateId: state.gate!.gateId,
      deliveryCommit: gated,
    });
    return { passed: true, acceptanceIds: state.spec.acceptance.map(item => item.id), deliveryCommit: gated };
  }

  recordOutcome(goalId: GoalId, decision: 'close' | 'revise' | 'stop'): void {
    const type = { close: 'outcome-accepted', revise: 'outcome-revised', stop: 'outcome-stopped' } as const;
    this.record(goalId, type[decision]);
  }
}
