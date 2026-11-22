import type { Appetite } from '../domain/contracts.js';
import { buildAssuranceReport, renderAssuranceText, type AssuranceReport } from '../domain/assurance-report.js';
import type { GateReport } from '../domain/gate.js';
import { buildPlan, type PlanSummary } from '../domain/plan.js';
import type { GoalEvent, GoalState, GoalStatus } from '../domain/transitions.js';
import { buildInbox, type InboxItem } from '../app/inbox.js';
import type { ReadOnlyJournal } from '../store/readonly-journal.js';

export type Holder = 'human' | 'lead' | 'done';
/** Who has the ball. Typed over every status, so a new status cannot ship without a holder. */
export const HOLDER: Record<GoalStatus, Holder> = {
  draft: 'human',
  approved: 'human',
  blocked: 'human',
  verified: 'human',
  selected: 'lead',
  planned: 'lead',
  testing: 'lead',
  executing: 'lead',
  legacy: 'done',
  closed: 'done',
  stopped: 'done',
};

export type UiInboxKind = InboxItem['kind'] | 'awaiting-approval' | 'awaiting-selection';
export type UiInboxItem = { goalId: string; kind: UiInboxKind; detail: string; at?: string };
export type GoalRow = {
  id: string;
  outcome?: string;
  status?: GoalStatus;
  holder?: Holder;
  mode?: string;
  packages: { green: number; total: number };
  /** True for a Goal an older APOS recorded: read-only, shown as an archive. */
  legacy: boolean;
  legacyOutcome?: 'verified' | 'closed' | 'stopped';
  appetite?: Appetite;
  /** The approved setup version the Goal is pinned to; absent = no setup. */
  setupVersion?: number;
  /** Most red gate runs any one package has had; the limit is per package, not per Goal. */ attempts: number;
  /** Wall minutes since `goal select`. */ elapsedMinutes: number;
  lastEventAt?: string;
  integrityError?: string;
};
export type Snapshot = {
  readAt: string;
  lastEventAt?: string;
  inbox: UiInboxItem[];
  goals: GoalRow[];
  plan?: PlanSummary;
};

const lastAt = (events: GoalEvent[]) => events.at(-1)?.at;
/** `attemptLimit` applies to each package on its own, so report the busiest one. */
function attemptsOf(state: GoalState): number {
  return Math.max(0, ...Object.values(state.packages ?? {}).map(item => item.attempts));
}

/** From `goal select`. A running or blocked Goal is still on the clock, so it counts to now; a finished one stops at its last event. */
function elapsedMinutes(events: GoalEvent[], state: GoalState, now: Date): number {
  const start = events.find(item => item.type === 'goal-selected');
  if (!start) return 0;
  const running = ['executing', 'blocked', 'selected', 'planned', 'testing'].includes(state.status);
  const end = running ? now.getTime() : Date.parse(events.at(-1)!.at);
  return Math.max(0, Math.round((end - Date.parse(start.at)) / 60_000));
}

function row(repo: ReadOnlyJournal, state: GoalState, now: Date): GoalRow {
  const packages = Object.values(state.packages ?? {});
  const events = repo.events(state.spec.id);
  return {
    id: state.spec.id,
    outcome: state.spec.outcome,
    status: state.status,
    holder: HOLDER[state.status],
    mode: state.proposal?.mode,
    packages: { green: packages.filter(item => item.status === 'green').length, total: packages.length },
    legacy: state.status === 'legacy',
    ...(state.legacyOutcome ? { legacyOutcome: state.legacyOutcome } : {}),
    appetite: state.appetite,
    ...(state.setupVersion === undefined ? {} : { setupVersion: state.setupVersion }),
    attempts: attemptsOf(state),
    elapsedMinutes: elapsedMinutes(events, state, now),
    lastEventAt: lastAt(events),
  };
}

/** The Human's gates A and B are not in `apos inbox`; the UI adds them so "what needs me" is in one place. */
function gateItems(repo: ReadOnlyJournal): UiInboxItem[] {
  const items: UiInboxItem[] = [];
  for (const state of repo.listGoals()) {
    const events = repo.events(state.spec.id);
    if (state.status === 'draft')
      items.push({
        goalId: state.spec.id,
        kind: 'awaiting-approval',
        detail: 'gate A: approve the Goal and its appetite',
        at: [...events].reverse().find(item => item.type === 'goal-drafted' || item.type === 'goal-revised')?.at,
      });
    if (state.status === 'approved')
      items.push({
        goalId: state.spec.id,
        kind: 'awaiting-selection',
        detail: 'gate B: select this Goal to run next',
        at: [...events].reverse().find(item => item.type === 'goal-approved')?.at,
      });
  }
  return items;
}

export function buildSnapshot(repo: ReadOnlyJournal, now: () => Date = () => new Date()): Snapshot {
  const goals: GoalRow[] = repo.goalIds().map(id => {
    const state = repo.getGoal(id);
    return state
      ? row(repo, state, now())
      : {
          id,
          packages: { green: 0, total: 0 },
          legacy: false,
          attempts: 0,
          elapsedMinutes: 0,
          integrityError: repo.failures.get(id),
        };
  });
  const lastEventAt = goals
    .map(item => item.lastEventAt)
    .filter((item): item is string => Boolean(item))
    .sort()
    .at(-1);
  const inbox: UiInboxItem[] = [...gateItems(repo), ...buildInbox(repo)];
  const plan = buildPlan(repo.listGoals());
  return { readAt: now().toISOString(), lastEventAt, inbox, goals, plan };
}

export type GateView = {
  scope: string;
  gateId: string;
  commit: string;
  result: string;
  at: string;
  warnings: string[];
  checks: {
    checkId: string;
    status: string;
    reason: string;
    newFailures: string[];
    logs: { role: 'base' | 'delivery'; logSha256: string; exitCode: number | null; timedOut: boolean }[];
  }[];
};

function gateView(scope: string, report: GateReport): GateView {
  return {
    scope,
    gateId: report.gateId,
    commit: report.deliveryCommit,
    result: report.result,
    at: report.at,
    warnings: report.warnings ?? [],
    checks: report.checks.map(check => ({
      checkId: check.checkId,
      status: check.status,
      reason: check.reason,
      newFailures: check.newFailures,
      logs: [
        ...check.base.map(run => ({ role: 'base' as const, run })),
        ...check.delivery.map(run => ({ role: 'delivery' as const, run })),
      ].map(({ role, run }) => ({ role, logSha256: run.logSha256, exitCode: run.exitCode, timedOut: run.timedOut })),
    })),
  };
}

function gateReports(state: GoalState): { scope: string; report: GateReport }[] {
  const reports: { scope: string; report: GateReport }[] = [];
  if (state.gate) reports.push({ scope: 'goal', report: state.gate });
  if (state.postMergeGate) reports.push({ scope: 'post-merge', report: state.postMergeGate });
  for (const [id, item] of Object.entries(state.packages ?? {}))
    if (item.gate) reports.push({ scope: id, report: item.gate });
  return reports;
}

/** Finds a gate log by the hash the controller recorded, so a request never names a path. */
export function findGateLog(state: GoalState, logSha256: string): string | undefined {
  for (const { report } of gateReports(state))
    for (const check of report.checks)
      for (const run of [...check.base, ...check.delivery]) if (run.logSha256 === logSha256) return run.logRef;
  return undefined;
}

export type GoalDetail = GoalRow & {
  requirementCount: number;
  packageList: {
    id: string;
    status: string;
    owner: string;
    outcome: string;
    dependencies: string[];
    attempts: number;
    blocker?: { kind: string; note: string };
    findings: string[];
  }[];
  findings: { kind: string; note: string; by: string; commit?: string }[];
  gates: GateView[];
  /** What the Goal's guarantees rest on, from the log alone (the stacks need the setup, which a read-only view does not load). */
  assurance: AssuranceReport;
  assuranceText: string;
  reviews: { subject: string; packageId?: string; result: string; reviewer: string; commitRef: string; note: string }[];
  blocker?: unknown;
  timeline: { events: { id: string; type: string; at: string; data?: string }[]; nextBefore?: string };
};

const clip = (data: unknown): string | undefined => {
  if (data === undefined) return undefined;
  const text = JSON.stringify(data) ?? '';
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
};

export function buildGoalDetail(
  repo: ReadOnlyJournal,
  id: string,
  options: { limit?: number; before?: string; now?: Date } = {},
): GoalDetail | undefined {
  const state = repo.getGoal(id);
  if (!state) return undefined;
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 200);
  const all = repo.events(id);
  const index = options.before ? all.findIndex(item => item.id === options.before) : all.length;
  const older = all.slice(0, index < 0 ? all.length : index);
  const page = older.slice(-limit);
  return {
    ...row(repo, state, options.now ?? new Date()),
    requirementCount: state.spec.requirements.length,
    packageList: Object.values(state.packages ?? {}).map(item => ({
      id: item.spec.id,
      status: item.status,
      owner: item.spec.owner,
      outcome: item.spec.outcome,
      dependencies: item.spec.dependencies,
      attempts: item.attempts,
      blocker: undefined,
      findings: item.finding ? [item.finding] : [],
    })),
    findings: (state.findings ?? []).map(item => ({
      kind: item.kind,
      note: item.note,
      by: item.by,
      commit: item.commit,
    })),
    gates: gateReports(state).map(({ scope, report }) => gateView(scope, report)),
    assurance: buildAssuranceReport(state),
    assuranceText: renderAssuranceText(buildAssuranceReport(state)),
    reviews: state.reviews.map(item => ({
      subject: item.subject,
      packageId: item.packageId,
      result: item.result,
      reviewer: item.reviewer,
      commitRef: item.commitRef,
      note: item.note,
    })),
    blocker: state.blocker,
    timeline: {
      events: page.map(item => ({ id: item.id, type: item.type, at: item.at, data: clip(item.data) })).reverse(),
      nextBefore: older.length > page.length ? page[0]?.id : undefined,
    },
  };
}
