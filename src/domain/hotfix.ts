import { z } from 'zod';
import type { CheckResult } from './gate.js';
import { parseGoalSpec, type GoalSpec } from './contracts.js';
import { bugGoalSpec, type BugCheck } from './bugfix.js';
import { sourceDigest } from './gate.js';
import type { GoalState } from './transitions.js';

/** The `via` that `apos hotfix` writes on the approval and selection of the Goal it opens, and what the table reads back. */
export const HOTFIX_APPROVE_VIA = 'hotfix';
/** What `--due` is when it is not given. */
export const DEFAULT_DUE = '24h';
export const HOTFIX_CHECK = 'APOS-HOTFIX';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `--due`: a whole number with its unit (`90m`, `24h`, `2d`). A bare number has no unit and is refused. */
export function dueMs(text: string): number | undefined {
  const match = /^(\d+)([mhd])$/.exec(text.trim());
  if (!match) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return ms > 0 ? ms : undefined;
}

/** The absolute deadline of a hotfix accepted at `acceptedAt`. */
export const dueAtOf = (acceptedAt: string, due: string): string | undefined => {
  const ms = dueMs(due);
  return ms === undefined ? undefined : new Date(Date.parse(acceptedAt) + ms).toISOString();
};

export type HotfixLink = NonNullable<GoalSpec['hotfixOf']>;
export const sameHotfix = (a: HotfixLink | undefined, b: HotfixLink | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.commit === b.commit && a.before === b.before && a.due === b.due && a.dueAt === b.dueAt;

/** What L0 and L1 said on the hotfix commit. They are recorded, never a gate: the merge is not held up. */
export const hotfixLayerSchema = z.object({
  part: z.string(),
  layer: z.enum(['L0', 'L1']),
  tool: z.string(),
  status: z.enum(['pass', 'fail', 'unverifiable']),
  note: z.string().optional(),
});
export type HotfixLayerResult = z.infer<typeof hotfixLayerSchema>;

/** Data of `hotfix-accepted`: the Human let this commit through now, and what APOS owes for it. */
export const hotfixAcceptedSchema = z.object({
  commit: z.string().min(1),
  before: z.string().min(1),
  description: z.string().min(1),
  due: z.string().min(1),
  dueAt: z.string().min(1),
  acceptedAt: z.string().min(1),
  by: z.enum(['human', 'on-behalf']),
  onBehalf: z.string().optional(),
  confirmation: z.unknown().optional(),
});
/** Data of `hotfix-gated`: the layers run on the hotfix commit, or why none ran. */
export const hotfixGatedSchema = z.object({
  commit: z.string().min(1),
  layers: z.array(hotfixLayerSchema),
  note: z.string().optional(),
});
export type HotfixRecord = Omit<z.infer<typeof hotfixAcceptedSchema>, 'confirmation'> & {
  layers?: HotfixLayerResult[];
  gateNote?: string;
};

/** `proven`: the Goal closed. `abandoned`: it was stopped, and the hotfix stays without evidence for good. */
export type HotfixStatus = 'proven' | 'waiting' | 'overdue' | 'abandoned';

export function hotfixStatus(state: GoalState, now: string): HotfixStatus | undefined {
  const hotfix = state.hotfix;
  if (!hotfix) return undefined;
  if (state.status === 'closed') return 'proven';
  if (state.status === 'stopped') return 'abandoned';
  return Date.parse(now) > Date.parse(hotfix.dueAt) ? 'overdue' : 'waiting';
}

export type HotfixRow = { goal: GoalState; hotfix: HotfixRecord; status: HotfixStatus };
export function hotfixRows(goals: GoalState[], now: string): HotfixRow[] {
  return goals.flatMap(goal => {
    const status = hotfixStatus(goal, now);
    return status && goal.hotfix ? [{ goal, hotfix: goal.hotfix, status }] : [];
  });
}
/** How many hotfixes still have no evidence: waiting, overdue, and the abandoned ones (a stopped Goal proves nothing). */
export const unprovenCount = (rows: HotfixRow[]): number => rows.filter(row => row.status !== 'proven').length;

export const STATUS_WORD: Record<HotfixStatus, string> = {
  proven: 'có bằng chứng',
  waiting: 'đang chờ',
  overdue: 'quá hạn',
  abandoned: 'bỏ dở',
};
export const unprovenLine = (count: number): string => `hotfix chưa có bằng chứng: ${count}`;
export const short = (sha: string): string => sha.slice(0, 7);
/** The layers L0 and L1 were red on, as the inbox says it: `hotfix đỏ ở L1`. Empty when none was. */
export const redLayers = (hotfix: HotfixRecord): string[] => [
  ...new Set((hotfix.layers ?? []).filter(item => item.status === 'fail').map(item => item.layer)),
];
export const redNote = (hotfix: HotfixRecord): string =>
  redLayers(hotfix).length ? `hotfix đỏ ở ${redLayers(hotfix).join(', ')}` : '';

/**
 * A delivery of a hotfix Goal must contain the hotfix commit: the Tester adds tests, the fix itself is the commit the
 * Human let through. A delivery without it proves nothing about the code that is in production.
 */
export function hotfixCheck(input: { hotfix: HotfixRecord; contains: boolean }): CheckResult {
  const { hotfix, contains } = input;
  return {
    checkId: HOTFIX_CHECK,
    status: contains ? 'pass' : 'fail',
    reason: contains
      ? `the delivery contains the hotfix commit ${short(hotfix.commit)}`
      : `the delivery does not contain the hotfix commit ${hotfix.commit}: the evidence must be the hotfix plus the tests, so build the delivery on it (merge the hotfix into the tests commit)`,
    base: [],
    delivery: [],
    newFailures: [],
  };
}

/** The verbatim source of a hotfix Goal: what was let through, why, and by when the evidence is due. */
export function hotfixSourceText(input: {
  description: string;
  commit: string;
  before: string;
  due: string;
  dueAt: string;
  given?: string;
  when?: string;
  then?: string;
  part?: string;
}): string {
  const lines = [
    '# Hotfix',
    '',
    input.description,
    '',
    `- Commit hotfix: ${input.commit}`,
    `- Commit trước hotfix: ${input.before}`,
    `- Hạn bằng chứng: ${input.due} (${input.dueAt})`,
  ];
  if (input.given) lines.push(`- Cho trước: ${input.given}`);
  if (input.when) lines.push(`- Khi: ${input.when}`);
  if (input.then) lines.push(`- Thì: ${input.then}`);
  if (input.part) lines.push(`- Phần: ${input.part}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The bugfix Goal a hotfix opens. With a Given/When/Then it is the Goal `apos bug open` would draft (one criterion, the
 * check of the setup) plus the link to the hotfix; without one it is a sketch that waits for the PM to revise in the
 * criterion, which is the only thing a hotfix Goal is allowed to be short of.
 */
export function hotfixGoalDraft(input: {
  id: string;
  description: string;
  link: HotfixLink;
  now: string;
  report?: { given: string; when: string; then: string };
  check?: BugCheck;
  part?: string;
  reproHint?: string;
}): { spec: GoalSpec; text: string } {
  const { id, description, link } = input;
  const text = hotfixSourceText({ description, ...link, ...input.report, part: input.part });
  if (input.report && input.check)
    return {
      text,
      spec: bugGoalSpec({
        id,
        report: {
          description,
          ...input.report,
          ...(input.part ? { part: input.part } : {}),
          ...(input.reproHint ? { reproHint: input.reproHint } : {}),
        },
        check: input.check,
        now: input.now,
        sourceText: text,
        hotfixOf: link,
      }),
    };
  return {
    text,
    spec: parseGoalSpec({
      id,
      version: 1,
      kind: 'bugfix',
      hotfixOf: link,
      ...(input.part ? { part: input.part } : {}),
      ...(input.reproHint ? { reproHint: input.reproHint } : {}),
      outcome: description,
      source: { path: 'hotfix', sha256: sourceDigest(text), capturedAt: input.now, origin: 'human' },
      requirements: [{ id: 'R-1', sourceSpan: 'hotfix', text: description, disposition: 'acceptance' }],
      scope: [`the code the hotfix ${short(link.commit)} changed`],
    }),
  };
}
