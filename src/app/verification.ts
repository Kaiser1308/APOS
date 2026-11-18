import { newEvent } from './events.js';
import type { Evidence, GoalId } from '../domain/contracts.js';
import type { GoalEventType } from '../domain/transitions.js';
import { requiresIndependentReview } from '../domain/reviews.js';
import { gateShortfalls } from '../domain/gate.js';
import type { GoalRepository } from '../ports/goal-repository.js';

export type VerificationResult = { passed: true; acceptanceIds: string[]; deliveryCommit: string };

export class VerificationService {
  constructor(private readonly store: GoalRepository) {}

  private record(goalId: GoalId, type: GoalEventType, data?: unknown): void {
    this.store.append(newEvent(goalId, type, data));
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
    if (decision === 'close') {
      const closing = this.store.getGoal(goalId);
      const acceptedIds = new Set(
        (closing?.spec.requirements ?? []).filter(r => r.disposition === 'acceptance').map(r => r.id),
      );
      for (const other of this.store.listGoals()) {
        if (other.spec.id === goalId) continue;
        for (const req of other.spec.requirements) {
          if (req.disposition === 'excluded' && req.exclusion?.kind === 'deferred' && req.exclusion.to === goalId) {
            if (!acceptedIds.has(req.id)) {
              this.record(goalId, 'human-notified', {
                kind: 'orphan-requirement',
                goalId,
                fromGoalId: other.spec.id,
                requirementId: req.id,
                note: `Requirement ${req.id} was deferred from ${other.spec.id} to ${goalId}, which closed without accepting it.`,
              });
            }
          }
        }
      }
    }
    const type = { close: 'outcome-accepted', revise: 'outcome-revised', stop: 'outcome-stopped' } as const;
    this.record(goalId, type[decision]);
  }
}
