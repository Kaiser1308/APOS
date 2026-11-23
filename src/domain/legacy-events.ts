/**
 * Events written while APOS itself dispatched, woke and watched agents. APOS v3 only assures output
 * and no longer emits or acts on any of them, but logs that hold them must still replay. A Goal with
 * at least one of them is `legacy`: read-only, shown as an archive.
 */
export const LEGACY_EVENT_NAMES = [
  'dispatch-intended',
  'lead-dispatch-intended',
  'lead-started',
  'lead-settled',
  'lead-woken',
  'lead-returned',
  'lead-transferred',
  'lead-bot-checked-in',
  'package-dispatch-intended',
  'package-dispatch-approved',
  'package-dispatch-held',
  'package-started',
  'package-resumed',
  'package-resume-intended',
  'package-approval-policy-set',
  'package-approval-policy-initialized',
  'package-failure-decided',
  'package-retry-exhausted',
  'owner-handed-off',
  'handoff-intended',
  'owner-progress-observed',
  'review-dispatched',
  'review-intended',
  'resume-intended',
  'runtime-resumed',
  'worker-settled',
  'controller-requested',
  'controller-request-attempted',
  'controller-request-settled',
  'telemetry-recorded',
  'multi-time-exhausted',
  'execution-started',
  'intent-abandoned',
  'checkpointed',
  'package-evidence-submitted',
  'package-verified',
  'package-blocked',
  'package-unblocked',
] as const;
export type LegacyEventType = (typeof LEGACY_EVENT_NAMES)[number];
export const LEGACY_EVENT_TYPES: ReadonlySet<string> = new Set<string>(LEGACY_EVENT_NAMES);

export function isLegacyGoal(events: readonly { type: string }[]): boolean {
  return events.some(event => LEGACY_EVENT_TYPES.has(event.type));
}
