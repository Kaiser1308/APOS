import { z } from 'zod';
import { UserError } from './errors.js';
import { stageLayersSchema } from './layer-plan.js';

const namedText = z.string().trim().min(1);
const id = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9-]+$/);
const version = z.number().int().positive();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-fA-F]{40,64}$/);

/** Immutable verbatim snapshot of where the Goal came from. Stored at `.apos/goals/<id>/source.md`. */
const sourceSchema = z.object({
  path: namedText,
  sha256,
  capturedAt: z.string().refine(value => !Number.isNaN(Date.parse(value)), 'ISO timestamp required'),
  origin: namedText,
});

/** One requirement lifted out of the source. Every one must be covered by acceptance or excluded with a reason. */
const exclusionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deferred'), to: id }),
  z.object({ kind: z.literal('out-of-scope') }),
]);

const requirementSchema = z.object({
  id,
  sourceSpan: namedText,
  text: namedText,
  disposition: z.enum(['acceptance', 'excluded']),
  exclusion: exclusionSchema.optional(),
  exclusionReason: namedText.optional(),
});

const ambiguitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), decision: namedText }),
  z.object({ status: z.literal('blocked'), question: namedText }),
]);

const acceptanceSchema = z.object({
  id,
  text: namedText,
  requirementIds: z.array(id).min(1),
  examples: z.array(z.object({ input: namedText, expected: namedText })).default([]),
  boundaries: z.array(namedText).default([]),
  prohibited: z.array(namedText).default([]),
  checkIds: z.array(id).min(1),
  ambiguity: ambiguitySchema.optional(),
  /**
   * How the criterion is proved. Absent means `red-green`: a test that is red before the work and green after.
   * `benchmark` and `scan` arrive in phase 4. Kept optional so Goals written earlier replay unchanged.
   */
  proof: z.enum(['red-green', 'stays-green', 'manual']).optional(),
  given: namedText.optional(),
  when: namedText.optional(),
  then: namedText.optional(),
});

/**
 * A check the controller runs itself. `expect: 'pass'` means the command must exit 0 on the delivery commit.
 * `expect: 'no-new-failures'` runs base and delivery and fails only on failures that are new at delivery;
 * failure identities come from `failurePattern` (regex, capture group 1 = test id, one match per failure),
 * or, with `format`, from the failed and errored tests of the standard report the command writes.
 */
const checkSchema = z.discriminatedUnion('kind', [
  z.object({
    id,
    kind: z.literal('command'),
    command: namedText,
    expect: z.enum(['pass', 'no-new-failures']),
    failurePattern: namedText.optional(),
    /** Read failures from a standard report instead of `failurePattern`. */
    format: z.enum(['junit', 'apos-json']).optional(),
    /** Report location: a path or glob relative to the worktree. Without it, the command must contain `{report}`. */
    report: namedText.optional(),
    runs: z.number().int().min(1).max(5).default(1),
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({ id, kind: z.literal('manual'), procedure: namedText, expectedResult: namedText }),
]);

const goalSchema = z
  .object({
    id,
    version,
    outcome: namedText,
    source: sourceSchema,
    requirements: z.array(requirementSchema).min(1),
    scope: z.array(namedText).default([]),
    exclusions: z.array(namedText).default([]),
    acceptance: z.array(acceptanceSchema).default([]),
    checks: z.array(checkSchema).default([]),
    dependencies: z.array(id).default([]),
    priority: z.number().int().nonnegative().default(1),
    /** Switches the Human approves with the Goal (`mutation`, `perf`): a setup tool that says `when: flag:x` runs only with `x`. */
    flags: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'a flag is a word')).optional(),
  })
  .superRefine((goal, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const sketch = goal.acceptance.length === 0 && goal.checks.length === 0;
    if (!sketch && goal.acceptance.length === 0)
      issue(['acceptance'], 'Goal must declare at least one acceptance criterion');
    if (!sketch && goal.checks.length === 0) issue(['checks'], 'Goal must declare at least one check');
    if (!sketch && goal.scope.length === 0) issue(['scope'], 'Goal must declare at least one scope entry');
    const unique = (items: { id: string }[], label: string, path: string) => {
      const seen = new Set<string>();
      for (const item of items) {
        if (seen.has(item.id)) issue([path], `Duplicate ${label} ID: ${item.id}`);
        seen.add(item.id);
      }
    };
    unique(goal.acceptance, 'acceptance', 'acceptance');
    unique(goal.requirements, 'requirement', 'requirements');
    unique(goal.checks, 'check', 'checks');
    const requirements = new Map(goal.requirements.map(item => [item.id, item]));
    const checks = new Set(goal.checks.map(item => item.id));
    for (const [index, item] of goal.requirements.entries()) {
      if (item.disposition === 'excluded' && !item.exclusionReason)
        issue(['requirements', index], `Excluded requirement ${item.id} needs a reason`);
      if (item.disposition === 'acceptance' && item.exclusion)
        issue(
          ['requirements', index, 'exclusion'],
          `Requirement ${item.id} is an acceptance requirement and cannot also carry an exclusion: drop the exclusion or mark it excluded`,
        );
    }
    for (const [index, item] of goal.acceptance.entries()) {
      for (const requirementId of item.requirementIds) {
        const requirement = requirements.get(requirementId);
        if (!requirement)
          issue(['acceptance', index], `Acceptance ${item.id} names unknown requirement ${requirementId}`);
        else if (requirement.disposition !== 'acceptance')
          issue(['acceptance', index], `Acceptance ${item.id} names excluded requirement ${requirementId}`);
      }
      for (const checkId of item.checkIds)
        if (!checks.has(checkId)) issue(['acceptance', index], `Acceptance ${item.id} names unknown check ${checkId}`);
    }
    for (const [index, item] of goal.checks.entries()) {
      if (item.kind === 'command' && item.format && !item.report && !item.command.includes('{report}'))
        issue(['checks', index], `Check ${item.id} has a report format but no report path or {report} in its command`);
      if (item.kind !== 'command' || !item.failurePattern) {
        if (item.kind === 'command' && item.expect === 'no-new-failures' && !item.format)
          issue(['checks', index], `Check ${item.id} needs failurePattern to compare base and delivery failures`);
        continue;
      }
      try {
        new RegExp(item.failurePattern, 'gm');
      } catch {
        issue(['checks', index], `Check ${item.id} has an invalid failurePattern`);
      }
    }
    if (goal.dependencies.includes(goal.id)) issue(['dependencies'], 'Goal cannot depend on itself');
    if (new Set(goal.dependencies).size !== goal.dependencies.length)
      issue(['dependencies'], 'Duplicate Goal dependency');
  });

const proposalSchema = z
  .object({
    id,
    version,
    goalId: id,
    goalVersion: version,
    mode: z.enum(['solo-direct', 'solo-phased', 'multi-wp']),
    approach: namedText,
    risks: z.array(namedText),
    baseCommit: commit.optional(),
    /** Hash of the source the Lead planned from; the controller refuses a plan made against another source. */
    sourceSha256: sha256.optional(),
    estimatedCost: z
      .object({ spendUsd: z.number().nonnegative().optional(), wallMinutes: z.number().positive() })
      .optional(),
    /** Why one owner beats splitting, or why splitting beats one owner. */
    rationale: namedText.optional(),
    /** Why splitting beats one owner; required for Multi-WP. */
    splitRationale: namedText.optional(),
    /** Paths whose change forces an independent review (shared interfaces, schemas). */
    sharedPaths: z.array(namedText).default([]),
    /** Solo: the globs WP-MAIN may change; Multi-WP packages carry their own. Required at `lead commit` for a Goal pinned to a setup. */
    paths: z.array(namedText).min(1).optional(),
    /** Empty skeleton files of the public entries (`entries`): the tester commits them, the worker fills them in. */
    stubPaths: z.array(namedText).optional(),
    /** The public entry points acceptance tests may call. */
    entries: z.array(namedText).optional(),
    /** Solo: layers added to WP-MAIN, by stage, on top of the setup's floor. Each must exist in the pinned setup. */
    layers: stageLayersSchema.optional(),
    acceptanceMapping: z
      .array(z.object({ acceptanceId: id, verification: namedText, level: z.literal('goal').optional() }))
      .min(1),
    verificationStrategy: namedText,
  })
  .superRefine((proposal, ctx) => {
    if (proposal.mode !== 'multi-wp') return;
    if (!proposal.splitRationale && !proposal.rationale)
      ctx.addIssue({
        code: 'custom',
        path: ['splitRationale'],
        message: 'Multi-WP needs a split rationale compared with Solo',
      });
    if (!proposal.estimatedCost)
      ctx.addIssue({
        code: 'custom',
        path: ['estimatedCost'],
        message: 'Multi-WP needs a cost estimate covering packages, integration and review',
      });
  });

/**
 * Controller-only budget the Human approves with the Goal: wall minutes from `goal select` to `verified`, and how
 * many red gates one package may have. It never appears in Goal documents.
 */
const appetiteSchema = z
  .object({
    size: z.enum(['S', 'M', 'L']),
    maxWallMinutes: z.number().int().positive(),
    maxAttempts: z.number().int().min(1).max(10),
    overrun: z.enum(['stop', 'ask']).optional(),
    /** The name an older APOS wrote; its `maxSpendUsd` is dropped, APOS cannot measure spend without running agents. */
    overrunPolicy: z.enum(['stop', 'ask']).optional(),
  })
  .transform(({ overrunPolicy, overrun, ...rest }) => ({ ...rest, overrun: overrun ?? overrunPolicy ?? 'ask' }));
export type Appetite = z.infer<typeof appetiteSchema>;
export function parseAppetite(value: unknown): Appetite {
  return appetiteSchema.parse(value);
}

export type GoalId = string;
export type SpecVersion = number;
export type GoalSpec = z.infer<typeof goalSchema>;
export type Acceptance = GoalSpec['acceptance'][number];
export type GoalCheck = GoalSpec['checks'][number];
export type CommandCheck = Extract<GoalCheck, { kind: 'command' }>;
export type ExecutionProposal = z.infer<typeof proposalSchema>;
export type PhaseCheckpoint = {
  phase: string;
  progress: string;
  evidenceRefs: string[];
  goalId?: string;
  attempt?: number;
};
export type Evidence = {
  acceptanceId: string;
  result: 'pass' | 'fail';
  command: string;
  artifactRef: string;
  commitRef?: string;
};

export function parseGoalSpec(value: unknown): GoalSpec {
  return goalSchema.parse(value);
}
export const isSketchGoal = (goal: GoalSpec): boolean => goal.acceptance.length === 0;
export function assertGoalExclusionComplete(goal: GoalSpec): void {
  for (const [index, item] of goal.requirements.entries()) {
    if (item.disposition !== 'excluded') continue;
    if (!item.exclusion?.kind)
      throw new UserError(
        `requirements.${index}.exclusion.kind: Excluded requirement ${item.id} must specify exclusion.kind ("deferred" with "to", or "out-of-scope")`,
      );
    if (item.exclusion.kind === 'deferred' && item.exclusion.to === goal.id)
      throw new UserError(
        `requirements.${index}.exclusion.to: Requirement ${item.id} cannot be deferred to its own Goal ${goal.id}`,
      );
  }
}
export function parseExecutionProposal(value: unknown): ExecutionProposal {
  return proposalSchema.parse(value);
}
export function proposalRationale(proposal: ExecutionProposal): string | undefined {
  return proposal.rationale ?? proposal.splitRationale;
}
export function assertProposalRationale(proposal: ExecutionProposal, recovery = ''): void {
  if (!proposalRationale(proposal))
    throw new UserError(
      `Proposal rationale (or splitRationale) is required: explain why this Goal uses one Solo owner or splits into packages${recovery}`,
    );
}

/**
 * Reasons a structurally valid Goal is not yet approvable. Drafts may be incomplete while PM and Human
 * shape them; approval requires every requirement covered or excluded, and no blocked ambiguity.
 */
export function goalApprovalBlockers(goal: GoalSpec): string[] {
  if (isSketchGoal(goal))
    return [
      `Goal ${goal.id} is a sketch (no acceptance criteria or checks yet); revise it with apos goal revise before approval`,
    ];
  const blockers: string[] = [];
  const covered = new Set(goal.acceptance.flatMap(item => item.requirementIds));
  for (const item of goal.requirements) {
    if (item.disposition === 'acceptance' && !covered.has(item.id))
      blockers.push(`Requirement ${item.id} has no acceptance criterion`);
  }
  for (const item of goal.acceptance) {
    if (item.ambiguity?.status === 'blocked')
      blockers.push(`Acceptance ${item.id} has an open question: ${item.ambiguity.question}`);
  }
  return blockers;
}
