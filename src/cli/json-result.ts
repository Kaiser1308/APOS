import type { GoalState } from '../domain/transitions.js';
import type { GateReport, GateResult } from '../domain/gate.js';

export type Verdict = 'green' | 'red' | 'unverifiable' | 'needs-human';
export function verdictOf(result: GateResult): Verdict {
  return result === 'pending' ? 'unverifiable' : result;
}
export function exitFor(verdict: Verdict): number {
  return verdict === 'green' ? 0 : verdict === 'red' ? 1 : 3;
}
export function jsonResult(
  command: string,
  state: GoalState | undefined,
  verdict: Verdict | null,
  report?: GateReport,
) {
  return {
    schemaVersion: 1,
    command,
    goalId: state?.spec.id ?? null,
    goalVersion: report?.goalVersion ?? state?.spec.version ?? null,
    setupVersion: report?.setupVersion ?? state?.setupVersion ?? null,
    baseCommit: report?.baseCommit ?? null,
    deliveryCommit: report?.deliveryCommit ?? null,
    verdict,
    findings: [],
    evidence:
      report?.checks.flatMap(check => [...check.base, ...check.delivery].map(run => ({ digest: run.logSha256 }))) ?? [],
    retryable: null,
    requiresHuman: verdict === 'needs-human' ? true : null,
    assuranceLimitations: [
      'Individual findings and caughtBy are not available from this result.',
      ...(!report ? ['No gate report is available for this result.'] : []),
    ],
    caughtBy: null,
  };
}
