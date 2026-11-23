import { z } from 'zod';
import { InvariantError } from './errors.js';
import { LAYER_IDS, type LayerId } from './layers.js';
import { DEFAULT_FLOOR, STAGES, type Stage } from './layer-plan.js';
import type { ProjectSetup } from './project-setup.js';
import type { GoalEvent, GoalState } from './transitions.js';

export const EXCEPTION_KINDS = [
  'needs-human',
  'tests-weakened',
  'tests-infra',
  'floor-reduced',
  'review-overridden',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
/** Spec 7.3: all of them are things the Human lets an agent approve; each approval is logged with who. */
export const AGENT_MAY_APPROVE: readonly ExceptionKind[] = EXCEPTION_KINDS;

const schema = z.object({
  kind: z.enum(EXCEPTION_KINDS),
  /** A package id for `needs-human` and `tests-infra`, the revision commit for `tests-weakened`, `<scope>:<stage>:<layer>` for `floor-reduced`, `<package or Goal id>:<review commit>` for `review-overridden`. */
  ref: z.string().min(1),
  commit: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
  reason: z.string().trim().min(1),
  /** `agent:<name>`, or `human` (then `confirmation` says how it was confirmed). */
  by: z.string().regex(/^(agent:\S+|human)$/, 'by is "agent:<name>" or "human"'),
  confirmation: z.object({ by: z.enum(['human', 'on-behalf']), onBehalf: z.string().min(1).optional() }).optional(),
});
export type ExceptionRecord = z.infer<typeof schema> & { at: string };

export function parseException(value: unknown): z.infer<typeof schema> {
  return schema.parse(value);
}

/** Whether `ref` at `commit` has an approved exception of that kind. */
export const hasException = (state: GoalState, kind: ExceptionKind, ref: string, commit: string): boolean =>
  (state.exceptions ?? []).some(
    item => item.kind === kind && item.ref === ref && item.commit.toLowerCase() === commit.toLowerCase(),
  );

export function applyException(state: GoalState, event: GoalEvent): GoalState {
  const data = parseException(event.data);
  if (data.by.startsWith('agent:') && !AGENT_MAY_APPROVE.includes(data.kind))
    throw new InvariantError(`An agent cannot approve ${data.kind}`);
  if (data.by === 'human' && !data.confirmation) throw new InvariantError('A Human exception needs its confirmation');
  return { ...state, exceptions: [...(state.exceptions ?? []), { ...data, at: event.at }] };
}

/** `floor-reduced` refs read `<scope>:<stage>:<layer>`: the scope is a package id (submit) or the Goal id (integrate, close). */
export function parseFloorRef(ref: string): { scope: string; stage: Stage; layer: LayerId } | undefined {
  const [scope, stage, layer, ...rest] = ref.split(':');
  if (!scope || rest.length || !(STAGES as readonly string[]).includes(stage ?? '')) return undefined;
  if (!(LAYER_IDS as readonly string[]).includes(layer ?? '')) return undefined;
  return { scope, stage: stage as Stage, layer: layer as LayerId };
}

/**
 * The floor layers an approved exception drops for `scope` at `stage`. Effective in log order: an exception counts for
 * every gate that runs after it was recorded, and never re-judges one that ran before.
 */
export function floorReductions(state: GoalState, scope: string, stage: Stage): { stage: Stage; layer: LayerId }[] {
  const out: { stage: Stage; layer: LayerId }[] = [];
  for (const entry of state.exceptions ?? []) {
    if (entry.kind !== 'floor-reduced') continue;
    const ref = parseFloorRef(entry.ref);
    if (ref && ref.scope === scope && ref.stage === stage) out.push({ stage, layer: ref.layer });
  }
  return out;
}

/** Why a `floor-reduced` ref cannot be approved, or undefined when it can: a real scope, a real stage, a layer the floor has there. */
export function floorRefProblem(input: {
  ref: string;
  goalId: string;
  packages: string[];
  setup: ProjectSetup;
}): string | undefined {
  const parsed = parseFloorRef(input.ref);
  if (!parsed) return `--ref for floor-reduced is <package>:<stage>:<layer>, e.g. WP-MAIN:submit:L2 (got ${input.ref})`;
  const { scope, stage, layer } = parsed;
  if (stage === 'submit' ? !input.packages.includes(scope) : scope !== input.goalId)
    return stage === 'submit'
      ? `${scope} is not a package of ${input.goalId}`
      : `at ${stage} the scope is the Goal itself: --ref ${input.goalId}:${stage}:${layer}`;
  if (!(input.setup.floor?.[stage] ?? DEFAULT_FLOOR[stage]).includes(layer))
    return `${layer} is not in the ${stage} floor of the setup, so there is nothing to reduce`;
  return undefined;
}
