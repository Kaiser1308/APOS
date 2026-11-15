import { z } from 'zod';
import type { ExecutionProposal, GoalSpec } from './contracts.js';

const text = z.string().trim().min(1);
const id = z.string().regex(/^[A-Z][A-Z0-9-]+$/);
const packageSchema = z.object({
  id: z.string().regex(/^WP-[A-Z0-9-]+$/),
  goalId: id,
  goalVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  owner: text,
  outcome: text,
  scope: z.array(text).min(1),
  exclusions: z.array(text),
  dependencies: z.array(z.string().regex(/^WP-[A-Z0-9-]+$/)),
  interfaces: z.array(text).min(1),
  acceptance: z.array(z.object({ id, text, goalAcceptanceId: id.optional(), checkIds: z.array(id).optional() })).min(1),
  integration: text,
});

export type WorkPackageSpec = z.infer<typeof packageSchema>;
export const packageEvidenceSchema = z.object({
  packageId: z.string().regex(/^WP-[A-Z0-9-]+$/),
  packageVersion: z.number().int().positive(),
  owner: text,
  acceptanceId: id,
  result: z.enum(['pass', 'fail']),
  command: text,
  artifactRef: text,
  commitRef: text,
});
export type PackageEvidence = z.infer<typeof packageEvidenceSchema>;
export function parsePackageEvidence(value: unknown): PackageEvidence {
  return packageEvidenceSchema.parse(value);
}
export function parseWorkPackage(value: unknown): WorkPackageSpec {
  return packageSchema.parse(value);
}

/**
 * A declared risk makes package verification wait for an independent package review, and APOS dispatches
 * no package reviewer. Refuse the plan up front instead of letting packages finish and then deadlock,
 * which forces a replan that resets them. Multi-WP always gets an independent Goal review, which also
 * reads the plan's approach, so a concern can be written there instead of declared as a risk.
 */
export function assertMultiWpPlannable(proposal: ExecutionProposal): void {
  if (proposal.mode === 'multi-wp' && proposal.risks.length) {
    throw new Error(
      'A Multi-WP plan cannot declare risks: they would require package reviews APOS does not dispatch. Put the concern in the approach; the Goal review is always independent.',
    );
  }
}

export function validatePackageGraph(goal: GoalSpec, proposal: ExecutionProposal, input: unknown[]): WorkPackageSpec[] {
  if (proposal.mode !== 'multi-wp' || proposal.goalId !== goal.id || proposal.goalVersion !== goal.version)
    throw new Error('Current Multi-WP proposal required');
  if (input.length < 2) throw new Error('Multi-WP requires at least two packages');
  const packages = input.map(parseWorkPackage);
  const byId = new Map<string, WorkPackageSpec>();
  for (const item of packages) {
    if (item.goalId !== goal.id || item.goalVersion !== goal.version) throw new Error(`Stale package: ${item.id}`);
    if (byId.has(item.id)) throw new Error(`Duplicate package ID: ${item.id}`);
    byId.set(item.id, item);
  }
  for (const item of packages) {
    const unversioned = item.interfaces.filter(entry => !/@v[0-9]+/.test(entry));
    if (unversioned.length)
      throw new Error(`Package ${item.id} interface needs a version (name@vN): ${unversioned.join(', ')}`);
    for (const dep of item.dependencies)
      if (!byId.has(dep)) throw new Error(`Missing dependency ${dep} for ${item.id}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (packageId: string): void => {
    if (visiting.has(packageId)) throw new Error(`Dependency cycle at ${packageId}`);
    if (visited.has(packageId)) return;
    visiting.add(packageId);
    for (const dep of byId.get(packageId)!.dependencies) walk(dep);
    visiting.delete(packageId);
    visited.add(packageId);
  };
  for (const item of packages) walk(item.id);
  const covered = new Set(
    packages.flatMap(item =>
      item.acceptance.map(ac => ac.goalAcceptanceId).filter((value): value is string => Boolean(value)),
    ),
  );
  const goalLevel = new Set(
    proposal.acceptanceMapping.filter(item => item.level === 'goal').map(item => item.acceptanceId),
  );
  for (const item of goal.acceptance)
    if (!covered.has(item.id) && !goalLevel.has(item.id)) throw new Error(`Unmapped Goal acceptance: ${item.id}`);
  for (const item of covered)
    if (!goal.acceptance.some(ac => ac.id === item)) throw new Error(`Unknown Goal acceptance: ${item}`);
  const checks = new Set(goal.checks.map(item => item.id));
  for (const item of packages)
    for (const criterion of item.acceptance)
      for (const checkId of criterion.checkIds ?? [])
        if (!checks.has(checkId)) throw new Error(`Package ${item.id} names unknown check ${checkId}`);
  return packages;
}
