import { z } from 'zod';

const namedText = z.string().trim().min(1);
const id = z.string().trim().regex(/^[A-Z][A-Z0-9-]+$/);
const version = z.number().int().positive();

const goalSchema = z.object({
  id, version, outcome: namedText,
  scope: z.array(namedText).min(1),
  exclusions: z.array(namedText),
  acceptance: z.array(z.object({ id, text: namedText })).min(1),
  appetite: namedText,
  dependencies: z.array(id),
  priority: z.number().int().nonnegative(),
  autoMergeAuthorized: z.boolean()
}).superRefine((goal, ctx) => {
  const seen = new Set<string>();
  for (const item of goal.acceptance) {
    if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: ['acceptance'], message: `Duplicate acceptance ID: ${item.id}` });
    seen.add(item.id);
  }
});

const proposalSchema = z.object({
  id, version, goalId: id, goalVersion: version,
  mode: z.enum(['solo-direct', 'solo-phased', 'multi-wp']),
  approach: namedText,
  risks: z.array(namedText),
  acceptanceMapping: z.array(z.object({ acceptanceId: id, verification: namedText })).min(1),
  verificationStrategy: namedText
});

export type GoalId = string;
export type SpecVersion = number;
export type GoalSpec = z.infer<typeof goalSchema>;
export type ExecutionProposal = z.infer<typeof proposalSchema>;
export type PhaseCheckpoint = { phase: string; progress: string; evidenceRefs: string[] };
export type Evidence = { acceptanceId: string; result: 'pass' | 'fail'; command: string; artifactRef: string };

export function parseGoalSpec(value: unknown): GoalSpec { return goalSchema.parse(value); }
export function parseExecutionProposal(value: unknown): ExecutionProposal { return proposalSchema.parse(value); }
