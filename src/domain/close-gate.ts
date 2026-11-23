import type { GoalState } from './transitions.js';

/**
 * Why a verified Goal pinned to a setup may not be closed yet, empty when it may: the close-stage layers must have
 * run green on the commit it was verified on. Layers an approved exception reduced are not run, so they do not stand
 * in the way. A Goal without a setup has no layers, so nothing is asked. Enforced where the Human closes (the CLI),
 * not when the log is replayed: Goals closed before this existed must still read back.
 */
export function closeLayerProblems(state: GoalState): string[] {
  if (state.setupVersion === undefined) return [];
  const gate = state.closeGate;
  if (!gate || gate.deliveryCommit.toLowerCase() !== state.verifiedCommit?.toLowerCase())
    return [`The close-stage layers have not run on ${state.verifiedCommit ?? 'the verified commit'}`];
  if (gate.result === 'green') return [];
  return [
    `The close-stage layers are ${gate.result} on ${gate.deliveryCommit}: ${gate.checks
      .filter(check => check.status !== 'pass')
      .map(check => `${check.checkId} ${check.status}: ${check.reason}`)
      .join('; ')}`,
  ];
}
