import { newEvent } from './events.js';
import type { Evidence, GoalId } from '../domain/contracts.js';
import { closeProblems, type GoalEventType } from '../domain/transitions.js';
import { UserError } from '../domain/errors.js';
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
    if (
      state?.status === 'verified' &&
      state.verifiedCommit &&
      (!deliveryCommit || deliveryCommit.toLowerCase() === state.verifiedCommit.toLowerCase())
    )
      return {
        passed: true,
        acceptanceIds: state.spec.acceptance.map(item => item.id),
        deliveryCommit: state.verifiedCommit,
      };
    if (!state || state.status !== 'executing') throw new Error('Goal must be executing to verify');
    const expected = state.proposal?.mode === 'multi-wp' ? state.integration?.commitRef : deliveryCommit;
    if (state.proposal?.mode === 'multi-wp' && !expected)
      throw new Error('Integrated Multi-WP commit required before verification');
    const problems = gateShortfalls(state.spec, state.gate, expected);
    if (problems.length) throw new Error(`Controller gate does not verify ${goalId}: ${problems.join('; ')}`);
    const gated = state.gate!.deliveryCommit;
    this.record(goalId, 'verified', {
      acceptanceIds: state.spec.acceptance.map(item => item.id),
      gateId: state.gate!.gateId,
      deliveryCommit: gated,
    });
    return { passed: true, acceptanceIds: state.spec.acceptance.map(item => item.id), deliveryCommit: gated };
  }

  recordOutcome(goalId: GoalId, decision: 'close' | 'revise' | 'stop', confirmation?: unknown): void {
    // Orphaned deferred requirements are not journaled: the inbox recomputes them from the Goal specs on every read.
    if (decision === 'close') {
      const state = this.store.getGoal(goalId);
      const problems = state ? closeProblems(state) : ['Goal not found'];
      if (problems.length) throw new UserError(problems.join('; '));
    }
    const type = { close: 'outcome-accepted', revise: 'outcome-revised', stop: 'outcome-stopped' } as const;
    this.record(goalId, type[decision], confirmation ? { confirmation } : undefined);
  }
}
