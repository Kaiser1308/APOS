import { InvariantError } from './errors.js';
import type { GoalEvent, GoalState } from './transitions.js';

/** Why a Lead may not ask for an integration gate now, or undefined when it may. */
export function integrationGateProblem(state: GoalState, commit: string, reason: string): string | undefined {
  if (state.proposal?.mode !== 'multi-wp' || state.status !== 'executing' || state.integration)
    return `${state.spec.id} is not an executing Multi-WP Goal awaiting integration`;
  if (!/^[0-9a-fA-F]{40,64}$/.test(commit)) return `${commit} is not a full commit hash`;
  if (!reason.trim()) return 'An integration gate request needs a reason';
  return undefined;
}

/**
 * `integration-gate-requested` records the Lead's request alone; the controller's gate that follows is gate-recorded.
 * `apos integration gate` checks the same rules first (as a UserError), so a violation here is a defect.
 */
export function applyIntegrationGateRequest(state: GoalState, event: GoalEvent): GoalState {
  const data = event.data as { commit?: string; reason?: string; by?: string } | undefined;
  const problem = integrationGateProblem(state, data?.commit ?? '', data?.reason ?? '');
  if (problem) throw new InvariantError(problem);
  if (!data?.by?.trim()) throw new InvariantError('An integration gate request needs who asked');
  return state;
}
