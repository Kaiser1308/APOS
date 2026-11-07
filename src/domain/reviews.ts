import { z } from 'zod';
import type { GoalState } from './transitions.js';

const text = z.string().trim().min(1);
const schema = z.object({
  subject: z.enum(['goal', 'package']),
  packageId: z.string().regex(/^WP-[A-Z0-9-]+$/).optional(),
  packageVersion: z.number().int().positive().optional(),
  reviewer: text,
  result: z.enum(['pass', 'changes']),
  commitRef: text,
  note: text
}).superRefine((review, ctx) => {
  if (review.subject === 'package' && (!review.packageId || !review.packageVersion)) ctx.addIssue({ code: 'custom', message: 'Package review requires ID and version' });
  if (review.subject === 'goal' && (review.packageId || review.packageVersion)) ctx.addIssue({ code: 'custom', message: 'Goal review cannot name a package' });
});

export type ReviewRecord = z.infer<typeof schema>;
export function parseReview(value: unknown): ReviewRecord { return schema.parse(value); }
export function requiresIndependentReview(state: GoalState): boolean {
  return Boolean(state.spec.autoMergeAuthorized || state.proposal?.risks.length);
}
