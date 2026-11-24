import { z } from 'zod';
import { UserError } from './errors.js';
import { stageLayersSchema } from './layer-plan.js';
import { THRESHOLD_OPS } from './threshold.js';

const namedText = z.string().trim().min(1);
const id = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9-]+$/);
const version = z.number().int().positive();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-fA-F]{40,64}$/);
const TOOL_REF = /^(?:[a-z][a-z0-9-]*)\.L[0-6]\.[^.\s][^\s]*$/;
/** A test of a `removed` criterion: `<part>.<layer>::<id as the layer report gives it>`, or `...::<file>` for every test of a file. */
const REMOVED_TEST = /^[a-z][a-z0-9-]*\.L[0-6]::\S.*$/;

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
  /** Goal checks that prove the criterion. At least one, except for a `benchmark` or `scan` criterion: the close stage proves it. */
  checkIds: z.array(id).default([]),
  ambiguity: ambiguitySchema.optional(),
  /**
   * How the criterion is proved. Absent means `red-green`: a test that is red before the work and green after.
   * `benchmark` and `scan` are non-functional proofs: a tool of the pinned setup that the gate runs at the close stage
   * against a threshold the Human approved with the Goal. Kept optional so Goals written earlier replay unchanged.
   */
  proof: z.enum(['red-green', 'stays-green', 'manual', 'benchmark', 'scan', 'removed']).optional(),
  /**
   * `proof: 'removed'`: the old tests of the feature that goes away, each `<part>.<layer>::<id>` or `<part>.<layer>::<file>` (every
   * test of that file). The Human approves the list with the Goal: they are the only tests the delivery may lose.
   */
  removesTests: z
    .array(z.string().regex(REMOVED_TEST, 'a removed test is "<part>.<layer>::<id>" (or "<part>.<layer>::<file>")'))
    .min(1)
    .optional(),
  /** `proof: 'benchmark'`: `tool` is `<part>.<layer>.<id>` of a `metric` tool; the criterion holds when `metric op value`. */
  benchmark: z
    .object({
      tool: z.string().regex(TOOL_REF, 'a tool is "<part>.<layer>.<id>"'),
      metric: namedText,
      op: z.enum(THRESHOLD_OPS),
      value: z.number().finite(),
    })
    .optional(),
  /** `proof: 'scan'`: `tool` is `<part>.<layer>.<id>` of a `sarif` tool; findings from `failOn` up fail the criterion. */
  scan: z
    .object({
      tool: z.string().regex(TOOL_REF, 'a tool is "<part>.<layer>.<id>"'),
      failOn: z.enum(['error', 'warning', 'note']),
    })
    .optional(),
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
    /** Absent means `feature`: Goals written before `apos bug` replay unchanged. A `bugfix` has one red-green criterion. */
    kind: z.enum(['feature', 'bugfix', 'characterize', 'refactor', 'maintenance']).optional(),
    /** `bugfix`: where the bug shows (a path), a hint for the Tester; it does not change any gate. */
    reproHint: namedText.optional(),
    /** `bugfix`: the setup part the bug lives in. */
    part: namedText.optional(),
    /** `characterize`: globs (repo-relative) of the code whose current behaviour the Goal captures; the Human approves them with the Goal. */
    covers: z.array(namedText).min(1).optional(),
    /**
     * `refactor`: globs (repo-relative) of the code to restructure; each file must be covered by a closed characterize Goal.
     * `maintenance`: globs of what the Goal may change besides the manifests and lockfiles of its part.
     */
    paths: z.array(namedText).min(1).optional(),
    /** `maintenance`: the base findings (fingerprints) the delivery must no longer show; the Human approves them with the Goal. */
    security: z.array(namedText).min(1).optional(),
    /** `maintenance`: what the base scan showed when the Goal was opened, kept once so the gate does not rerun the base. */
    baseline: z
      .object({
        commit: namedText,
        scans: z.array(
          z.object({
            tool: namedText,
            /** The command that scanned: a baseline stands only for the same scanner, so a setup that changes it is scanned again. */
            command: namedText.optional(),
            findings: z.array(
              z.object({
                fingerprint: namedText,
                ruleId: namedText,
                level: z.enum(['error', 'warning', 'note']),
                file: z.string().optional(),
              }),
            ),
          }),
        ),
      })
      .optional(),
    /** `maintenance`: the pull request the delivery comes from (`--from-pr`): its number, remote and the sha fetched when the Goal was opened. */
    fromPr: z.object({ number: z.number().int().positive(), remote: namedText, sha: namedText }).optional(),
    /**
     * `bugfix`: the Goal `apos hotfix` opened for a commit the Human let through. `before` is the commit the bug is reproduced
     * on, `dueAt` the absolute deadline of the evidence. It stays in the spec so a revision cannot drop it.
     */
    hotfixOf: z
      .object({
        commit: namedText,
        before: namedText,
        due: namedText,
        dueAt: namedText.refine(value => !Number.isNaN(Date.parse(value)), 'dueAt is a date'),
      })
      .optional(),
  })
  .superRefine((goal, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    // A refactor needs no criterion of its own: what it must keep is what the characterize Goals locked.
    // A maintenance Goal has none either: what it must hold is the base, measured by the gate.
    const refactor = goal.kind === 'refactor' || goal.kind === 'maintenance';
    const sketch = goal.acceptance.length === 0 && goal.checks.length === 0 && !refactor;
    const allAcceptanceUsesToolProofs =
      goal.acceptance.length > 0 && goal.acceptance.every(item => item.proof === 'benchmark' || item.proof === 'scan');
    if (!sketch && !refactor && goal.acceptance.length === 0)
      issue(['acceptance'], 'Goal must declare at least one acceptance criterion');
    if (!sketch && !refactor && !allAcceptanceUsesToolProofs && goal.checks.length === 0)
      issue(['checks'], 'Goal must declare at least one check');
    if (goal.kind === 'maintenance' && (goal.acceptance.length || goal.checks.length))
      issue(
        ['acceptance'],
        'A maintenance Goal has no criterion or check of its own: the gate holds it to the base (no new failure, no new finding, only manifests and its paths)',
      );
    if (goal.hotfixOf && goal.kind !== 'bugfix')
      issue(['hotfixOf'], `hotfixOf belongs to a bugfix Goal, not a ${goal.kind ?? 'feature'} one`);
    if (goal.kind === 'bugfix') {
      // A hotfix Goal opened without a Given/When/Then waits as a sketch until the PM revises it with its one criterion.
      const waiting = goal.hotfixOf !== undefined && goal.acceptance.length === 0 && goal.checks.length === 0;
      if (goal.acceptance.length !== 1 && !waiting)
        issue(
          ['acceptance'],
          `A bugfix Goal has exactly one acceptance criterion (it has ${goal.acceptance.length}): a bigger bug is an ordinary Goal`,
        );
      for (const [index, item] of goal.acceptance.entries())
        if (item.proof !== undefined && item.proof !== 'red-green')
          issue(['acceptance', index], `A bugfix criterion is proved by a red-green test, not "${item.proof}"`);
    }
    for (const [field, kinds] of [
      ['covers', ['characterize']],
      ['paths', ['refactor', 'maintenance']],
      ['security', ['maintenance']],
      ['baseline', ['maintenance']],
      ['fromPr', ['maintenance']],
    ] as const) {
      const wanted = kinds.includes(goal.kind as never);
      if (wanted && !goal[field] && goal.kind !== 'maintenance')
        issue([field], `A ${goal.kind} Goal says which code it is about: ${field} is required`);
      if (!wanted && goal[field])
        issue([field], `${field} belongs to a ${kinds[0]} Goal, not a ${goal.kind ?? 'feature'} one`);
    }
    if (goal.kind === 'characterize' || goal.kind === 'refactor')
      for (const [index, item] of goal.acceptance.entries())
        if (item.proof !== undefined && item.proof !== 'stays-green')
          issue(
            ['acceptance', index],
            goal.kind === 'characterize'
              ? `A characterize criterion is proved by a test that is green on the code as it is (stays-green), not "${item.proof}"`
              : `A refactor adds no new behaviour: its criteria are stays-green, not "${item.proof}"`,
          );
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
      const nonFunctional = item.proof === 'benchmark' || item.proof === 'scan';
      if (!nonFunctional && item.checkIds.length === 0)
        issue(['acceptance', index], `Acceptance ${item.id} needs at least one check`);
      if (item.proof === 'benchmark' && !item.benchmark)
        issue(
          ['acceptance', index],
          `Acceptance ${item.id} has proof "benchmark" but no benchmark: { tool, metric, op, value }`,
        );
      if (item.proof === 'scan' && !item.scan)
        issue(['acceptance', index], `Acceptance ${item.id} has proof "scan" but no scan: { tool, failOn }`);
      if (item.benchmark && item.proof !== 'benchmark')
        issue(['acceptance', index], `Acceptance ${item.id} has a benchmark but its proof is not "benchmark"`);
      if (item.scan && item.proof !== 'scan')
        issue(['acceptance', index], `Acceptance ${item.id} has a scan but its proof is not "scan"`);
      if ((item.proof === 'removed') !== (item.removesTests !== undefined))
        issue(
          ['acceptance', index],
          `Acceptance ${item.id}: removesTests (the old tests that go) and proof "removed" come together`,
        );
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
  })
  // A characterize or refactor criterion is "stays-green" unless it says so: no one has to write what the kind already means.
  .transform(goal =>
    goal.kind === 'characterize' || goal.kind === 'refactor'
      ? {
          ...goal,
          acceptance: goal.acceptance.map(item => ({ ...item, proof: item.proof ?? ('stays-green' as const) })),
        }
      : goal,
  );

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
    acceptanceMapping: z.array(
      z.object({ acceptanceId: id, verification: namedText, level: z.literal('goal').optional() }),
    ),
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
/** What kind of Goal this is; a Goal written before kinds existed is a feature. */
export const goalKind = (goal: GoalSpec): NonNullable<GoalSpec['kind']> => goal.kind ?? 'feature';
/** A Goal not yet shaped: no criterion. A refactor has none of its own and is not a sketch. */
export const isSketchGoal = (goal: GoalSpec): boolean =>
  goal.acceptance.length === 0 && goal.kind !== 'refactor' && goal.kind !== 'maintenance';
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
  // A refactor with no criterion answers to the locked characterization tests, not to a criterion per requirement.
  const needsCoverage = (goal.kind !== 'refactor' && goal.kind !== 'maintenance') || goal.acceptance.length > 0;
  for (const item of goal.requirements) {
    if (needsCoverage && item.disposition === 'acceptance' && !covered.has(item.id))
      blockers.push(`Requirement ${item.id} has no acceptance criterion`);
  }
  for (const item of goal.acceptance) {
    if (item.ambiguity?.status === 'blocked')
      blockers.push(`Acceptance ${item.id} has an open question: ${item.ambiguity.question}`);
  }
  return blockers;
}
