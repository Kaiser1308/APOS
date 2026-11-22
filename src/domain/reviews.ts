import { z } from 'zod';
import type { ExecutionProposal, GoalSpec } from './contracts.js';

const text = z.string().trim().min(1);
const schema = z
  .object({
    subject: z.enum(['goal', 'package']),
    packageId: z
      .string()
      .regex(/^WP-[A-Z0-9-]+$/)
      .optional(),
    packageVersion: z.number().int().positive().optional(),
    reviewer: text,
    /** The reviewer's own session, for the record. */
    session: text,
    result: z.enum(['pass', 'changes']),
    commitRef: text,
    note: text,
  })
  .superRefine((review, ctx) => {
    if (review.subject === 'package' && (!review.packageId || !review.packageVersion))
      ctx.addIssue({ code: 'custom', message: 'Package review requires ID and version' });
    if (review.subject === 'goal' && (review.packageId || review.packageVersion))
      ctx.addIssue({ code: 'custom', message: 'Goal review cannot name a package' });
  });

export type ReviewRecord = z.infer<typeof schema>;
export function parseReview(value: unknown): ReviewRecord {
  return schema.parse(value);
}

/** Manifests and build config: they decide what a check actually runs. */
const MANIFEST =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|setup\.(cfg|py)|requirements[^/]*\.txt|Makefile|go\.(mod|sum)|Cargo\.(toml|lock)|tox\.ini|pytest\.ini|(vitest|jest|vite)\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/i;
/** Test, spec and fixture files: changing them can make a gate green without fixing behaviour. */
const ORACLE =
  /(^|\/)(tests?|__tests__|spec|specs|fixtures?|testdata)\/|\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i;

/**
 * Things in a gated diff that deserve a human look: tests or oracles changed, shared interface paths touched, or
 * the files the checks run (or are built from) changed. Since v3 they no longer block anything: they are shown as
 * warnings in the gate report, the inbox and the UI. This is a known gap until test locking arrives (phase 3).
 */
export function reviewReasons(input: {
  spec: GoalSpec;
  proposal?: ExecutionProposal;
  changedFiles?: string[];
}): string[] {
  const state = input;

  const reasons: string[] = [];
  if (state.proposal?.risks.length) reasons.push(`declared risks: ${state.proposal.risks.join('; ')}`);
  const changed = state.changedFiles ?? [];
  const oracle = changed.filter(file => ORACLE.test(file));
  if (oracle.length) reasons.push(`tests or oracles changed: ${oracle.join(', ')} (not locked before phase 3)`);
  const shared = changed.filter(file =>
    (state.proposal?.sharedPaths ?? []).some(
      prefix => file === prefix || file.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
    ),
  );
  if (shared.length) reasons.push(`shared interface paths changed: ${shared.join(', ')}`);
  // A check is only as honest as the files it runs and the build that wires them.
  const commands = state.spec.checks.flatMap(check => (check.kind === 'command' ? [check.command] : [])).join(' ');
  const wired = changed.filter(
    file =>
      !oracle.includes(file) &&
      (MANIFEST.test(file) ||
        commands.split(/[\s"'=]+/).some(token => token && (token === file || token.replace(/^\.\//, '') === file))),
  );
  if (wired.length) reasons.push(`files the checks run or are built from changed: ${wired.join(', ')}`);
  return reasons;
}

/** The warnings a gate report carries for a diff. */
export const gateWarnings = (input: Parameters<typeof reviewReasons>[0]): string[] =>
  reviewReasons(input).map(reason => `needs attention: ${reason}`);
