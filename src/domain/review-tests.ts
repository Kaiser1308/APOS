import { z } from 'zod';
import { InvariantError } from './errors.js';
import { LAYER_IDS } from './layers.js';
import type { GoalEvent, GoalState } from './transitions.js';

const commit = z.string().regex(/^[0-9a-fA-F]{40,64}$/);
const testRef = z.object({ part: z.string().min(1), layer: z.enum(LAYER_IDS), id: z.string().min(1) });
export const testRefKey = (test: z.infer<typeof testRef>): string => `${test.part}.${test.layer}::${test.id}`;

/** What `apos review block` records: tests a reviewer added in a commit on top of a delivery, and that are red on it. */
const reviewBlockedSchema = z.object({
  /** Absent: the review is of the integration commit of a Multi-WP Goal. */
  packageId: z
    .string()
    .regex(/^WP-[A-Z0-9-]+$/)
    .optional(),
  deliveryCommit: commit,
  reviewCommit: commit,
  /** The file → sha256 of every test file the review commit adds. */
  files: z.record(z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/)),
  /** Every test the review commit adds, red or green: all of them are locked. */
  tests: z.array(testRef).min(1),
  /** The tests that are red on the delivery for a reason in the code: what blocks. */
  blocking: z.array(testRef).min(1),
  /** Blocking tests that are also red on the plan's base commit, with the new tests laid over it: may be a defect from before the Goal. */
  alsoRedBefore: z.array(testRef).default([]),
  by: z.string().trim().min(1),
  note: z.string().trim().min(1).optional(),
});
export type ReviewTestLock = z.infer<typeof reviewBlockedSchema>;
export const parseReviewBlocked = (value: unknown): ReviewTestLock => reviewBlockedSchema.parse(value);

/** `blocked by review: <ids>`, with a note for the ids that were red before the Goal too. */
export function blockReason(data: ReviewTestLock): string {
  const before = new Set(data.alsoRedBefore.map(testRefKey));
  const ids = data.blocking.map(
    test => `${test.id}${before.has(testRefKey(test)) ? ' (also red before the Goal: may be an existing defect)' : ''}`,
  );
  return `blocked by review: ${ids.join(', ')}`;
}

/** The ref an exception `review-overridden` uses for one review block. */
export const reviewRef = (lock: Pick<ReviewTestLock, 'packageId' | 'reviewCommit'>, goalId: string): string =>
  `${lock.packageId ?? goalId}:${lock.reviewCommit}`;

/** Who overrode this block with an approved `review-overridden` exception, if anyone: the block then asks nothing of the delivery. */
export function reviewOverrideBy(state: GoalState, review: ReviewTestLock): string | undefined {
  const ref = reviewRef(review, state.spec.id).toLowerCase();
  return [...(state.exceptions ?? [])]
    .reverse()
    .find(entry => entry.kind === 'review-overridden' && entry.ref.toLowerCase() === ref)?.by;
}

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new InvariantError(message);
}

/**
 * A review that blocks puts its package back to red (a red gate: it spends an attempt) and the Goal back to
 * executing, and keeps the reviewer's tests: from then on the package's delivery must contain them, unchanged, and pass.
 */
export function applyReviewBlocked(state: GoalState, event: GoalEvent, attemptLimit: number): GoalState {
  const data = parseReviewBlocked(event.data);
  requireThat(
    state.status === 'executing' || state.status === 'verified',
    'A review blocks the delivery of an executing or verified Goal',
  );
  const reviewTests = [...(state.reviewTests ?? []), data];
  const reason = blockReason(data);
  if (!data.packageId) {
    requireThat(
      state.integration?.commitRef.toLowerCase() === data.deliveryCommit.toLowerCase(),
      'The review is not of the integration commit',
    );
    return {
      ...state,
      status: 'executing',
      integration: undefined,
      gate: undefined,
      verifiedCommit: undefined,
      closeGate: undefined,
      reviewTests,
    };
  }
  const item = state.packages?.[data.packageId];
  requireThat(
    item?.gate && item.gate.deliveryCommit.toLowerCase() === data.deliveryCommit.toLowerCase(),
    'The review is not of the latest gated commit of the package',
  );
  const attempts = item.attempts + 1;
  const next: GoalState = {
    ...state,
    status: 'executing',
    gate: undefined,
    verifiedCommit: undefined,
    closeGate: undefined,
    integration: undefined,
    reviewTests,
    packages: {
      ...state.packages,
      [item.spec.id]: { ...item, status: 'red', attempts, finding: reason, submission: item.submission },
    },
  };
  return attempts > attemptLimit
    ? {
        ...next,
        status: 'blocked',
        blocker: {
          kind: 'technical',
          note: `${item.spec.id} was blocked by review ${attempts} times, over the approved limit of ${attemptLimit}`,
        },
      }
    : next;
}
