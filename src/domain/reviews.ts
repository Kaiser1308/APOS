import { z } from 'zod';
import type { GoalState } from './transitions.js';

const text = z.string().trim().min(1);
const schema = z.object({
  subject: z.enum(['goal', 'package']),
  packageId: z.string().regex(/^WP-[A-Z0-9-]+$/).optional(),
  packageVersion: z.number().int().positive().optional(),
  reviewer: text,
  /** The reviewer's own session: an Orca Dispatch ID, or `human:<name>`. A name alone is not enough. */
  session: text,
  result: z.enum(['pass', 'changes']),
  commitRef: text,
  note: text
}).superRefine((review, ctx) => {
  if (review.subject === 'package' && (!review.packageId || !review.packageVersion)) ctx.addIssue({ code: 'custom', message: 'Package review requires ID and version' });
  if (review.subject === 'goal' && (review.packageId || review.packageVersion)) ctx.addIssue({ code: 'custom', message: 'Goal review cannot name a package' });
});

export type ReviewRecord = z.infer<typeof schema>;
export function parseReview(value: unknown): ReviewRecord { return schema.parse(value); }

/** Manifests and build config: they decide what a check actually runs. */
const MANIFEST = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|setup\.(cfg|py)|requirements[^/]*\.txt|Makefile|go\.(mod|sum)|Cargo\.(toml|lock)|tox\.ini|pytest\.ini|(vitest|jest|vite)\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/i;
/** Test, spec and fixture files: changing them can make a gate green without fixing behaviour. */
const ORACLE = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|testdata)\/|\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i;

/**
 * Why an independent review is required, derived from the plan and the gated diff rather than only
 * from risks the Lead chose to declare. Empty when the controller gate alone is enough.
 */
export function reviewReasons(state: GoalState): string[] {
  const reasons: string[] = [];
  if (state.proposal?.mode === 'multi-wp') reasons.push('Multi-WP integration');
  if (state.proposal?.risks.length) reasons.push(`declared risks: ${state.proposal.risks.join('; ')}`);
  const changed = state.gate?.changedFiles ?? [];
  const oracle = changed.filter(file => ORACLE.test(file));
  if (oracle.length) reasons.push(`tests or oracles changed: ${oracle.join(', ')}`);
  const shared = changed.filter(file => (state.proposal?.sharedPaths ?? []).some(prefix => file === prefix || file.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)));
  if (shared.length) reasons.push(`shared interface paths changed: ${shared.join(', ')}`);
  // A check is only as honest as the files it runs and the build that wires them.
  const commands = state.spec.checks.flatMap(check => check.kind === 'command' ? [check.command] : []).join(' ');
  const wired = changed.filter(file => !oracle.includes(file) && (MANIFEST.test(file) || commands.split(/[\s"'=]+/).some(token => token && (token === file || token.replace(/^\.\//, '') === file))));
  if (wired.length) reasons.push(`files the checks run or are built from changed: ${wired.join(', ')}`);
  return reasons;
}
export function requiresIndependentReview(state: GoalState): boolean { return reviewReasons(state).length > 0; }

/** Owner identities and sessions a reviewer must not share. */
export function ownerIdentities(state: GoalState, packageId?: string): { names: string[]; sessions: string[] } {
  const items = Object.values(state.packages ?? {}).filter(item => !packageId || item.spec.id === packageId);
  const refs = [...(packageId ? [] : [state.runtimeRef]), ...items.map(item => item.runtimeRef)] as ({ dispatchId?: string; terminal?: string } | undefined)[];
  const names = packageId ? items.map(item => item.spec.owner) : ['lead', ...items.map(item => item.spec.owner)];
  return { names: names.map(name => name.toLowerCase()), sessions: refs.flatMap(ref => [ref?.dispatchId, ref?.terminal]).filter((value): value is string => Boolean(value)) };
}
