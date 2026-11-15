import { newEvent } from './events.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { GoalEventType, GoalState } from '../domain/transitions.js';
import { worktreePath } from '../runtime/orca.js';
import type { RuntimeRef } from '../domain/runtime-refs.js';
import type { TelemetryProbe } from '../ports/telemetry.js';
import type { GateReport } from '../domain/gate.js';
import { reviewResultPath } from '../runtime/brief.js';
import { dispatchAgent, watchDispatch } from './watch.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { RuntimeAdapter } from '../ports/runtime.js';

export const show = (repo: string, commit: string, path: string): string | undefined => {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${commit}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

/**
 * Seen live with Codex in Orca: a brief pasted but never submitted, for owners, resumes and reviewers.
 * Orca never resends, so the controller owns this: from one quiet minute on, while the screen shows an
 * unsent brief, press Enter up to three times a minute apart; then the Human is told. An agent that is
 * visibly working is never reported.
 */
export async function unstickDispatch(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  now: () => number,
  input: { goalId: string; dispatchId: string; terminal?: string; since?: string; requested?: { agent?: string } },
): Promise<string[]> {
  if (!runtime.nudge || !input.terminal || !input.since) return [];
  if (now() - Date.parse(input.since) < 60_000) return [];
  const pending = runtime.composerPending
    ? await runtime.composerPending(input.terminal, await dispatchAgent(runtime, input.dispatchId, input.requested))
    : await runtime.inputStalled?.(input.dispatchId);
  if (!pending) return [];
  const marker = `nudge ${input.dispatchId}`;
  const events = store.events(input.goalId);
  const nudges = events.filter(
    item => item.type === 'decision-logged' && String((item.data as { note?: string }).note).startsWith(marker),
  );
  const record = (type: GoalEventType, data: unknown) =>
    store.append(newEvent(input.goalId, type, data, new Date(now()).toISOString()));
  if (nudges.length < 3) {
    if (nudges.length && now() - Date.parse(nudges.at(-1)!.at) < 60_000) return [];
    await runtime.nudge(input.terminal);
    record('decision-logged', {
      note: `${marker}: brief unsent in the composer; controller pressed Enter (${nudges.length + 1}/3)`,
    });
    return [`nudged ${input.dispatchId} (${nudges.length + 1}/3)`];
  }
  const notified = events.some(
    item =>
      item.type === 'human-notified' &&
      (item.data as { kind?: string; dispatchId?: string }).kind === 'stalled' &&
      (item.data as { dispatchId?: string }).dispatchId === input.dispatchId,
  );
  if (notified || now() - Date.parse(nudges.at(-1)!.at) < 60_000) return [];
  record('human-notified', {
    kind: 'stalled',
    goalId: input.goalId,
    dispatchId: input.dispatchId,
    note: 'brief still unsent after three Enters',
  });
  return [`stalled ${input.dispatchId}; Human notified`];
}

/**
 * Non-APOS commits on the managed checkout since the base that touch this Goal's evidence: the
 * signature of an owner working in the checkout. Ordinary Human commits elsewhere are not flagged.
 */
export function foreignCommits(repoPath: string, base: string, goalId: string): string[] {
  try {
    const rows = execFileSync(
      'git',
      ['-C', repoPath, 'log', '--format=%H%x09%ae', `${base}..HEAD`, '--', `.apos/goals/${goalId}/evidence/`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    return rows.filter(row => row.split('\t')[1] !== 'apos@local.invalid').map(row => row.slice(0, 12));
  } catch {
    return [];
  }
}

/** The owner's own account of unfinished work: its "Remaining" section, else the end of the report. */
export function remaining(report: string): string {
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex(line => /^#+\s*Remaining/i.test(line));
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && /^#+\s/.test(line));
  const section =
    start < 0
      ? ''
      : lines
          .slice(start + 1, end < 0 ? undefined : end)
          .join(' ')
          .trim();
  return (section || report.trim().slice(-800)).slice(0, 1500);
}

export function describe(gate: GateReport): string {
  return gate.checks
    .filter(item => item.status !== 'pass')
    .map(
      item =>
        `${item.checkId} ${item.status} (${item.reason}${item.newFailures.length ? `; new: ${item.newFailures.join(', ')}` : ''})`,
    )
    .join('; ');
}

/** Watches an unsettled dispatch, then nudges it when its brief sits unsent: the two checks every wake runs together. */
export async function watchAndUnstick(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  now: () => number,
  watch: Parameters<typeof watchDispatch>[3],
  since: string | undefined,
): Promise<string[]> {
  return [
    ...(await watchDispatch(store, runtime, now, watch)),
    ...(await unstickDispatch(store, runtime, now, {
      goalId: watch.goalId,
      dispatchId: watch.dispatchId,
      terminal: watch.terminal,
      since,
      requested: watch.requested,
    })),
  ];
}

/** The reviewer's committed verdict, or undefined when it is missing, unparsable or lacks a result and a note. */
export async function readReviewResult(
  runtime: RuntimeAdapter,
  repoPath: string,
  goalId: string,
  pending: { worktreeId?: string; dispatchId: string; key: string },
): Promise<{ result: 'pass' | 'changes'; note: string } | undefined> {
  const head = await runtime.deliveryHead?.({ worktreeId: pending.worktreeId, dispatchId: pending.dispatchId });
  const raw = head && show(repoPath, head, reviewResultPath(goalId, pending.key));
  let result: { result?: string; note?: string } | undefined;
  // PowerShell writes a UTF-8 BOM (seen live: a valid review was rejected).
  try {
    result = raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : undefined;
  } catch {
    result = undefined;
  }
  if (!result || !['pass', 'changes'].includes(result.result ?? '') || !result.note?.trim()) return undefined;
  return result as { result: 'pass' | 'changes'; note: string };
}

/** Records a dispatch's launch model and token usage once, from the worktree's agent transcripts. */
export async function recordTelemetry(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  now: () => number,
  probe: TelemetryProbe | undefined,
  state: GoalState,
  ref: RuntimeRef,
  role: 'lead' | 'worker' | 'reviewer',
): Promise<void> {
  if (state.telemetry?.some(item => item.dispatchId === ref.dispatchId)) return;
  const receipt = await runtime.launchReceipt?.(ref.dispatchId).catch(() => undefined);
  const events = store.events(state.spec.id);
  // A Solo owner is the Lead: its window opens when the Lead was dispatched, so planning counts (design: lead-owns-solo Q2).
  const startedAt = events.findIndex(
    item =>
      ['lead-started', 'execution-started', 'runtime-resumed', 'review-dispatched'].includes(item.type) &&
      (item.data as { dispatchId?: string })?.dispatchId === ref.dispatchId,
  );
  // The window opens at the dispatch intent: a dispatch recovered later was already running before it was recorded (seen live).
  const intent =
    startedAt > 0 &&
    ['dispatch-intended', 'resume-intended', 'lead-dispatch-intended'].includes(events[startedAt - 1].type)
      ? events[startedAt - 1]
      : undefined;
  const started = intent ?? (startedAt >= 0 ? events[startedAt] : undefined);
  const path = worktreePath(ref.worktreeId);
  const until = new Date(now()).toISOString();
  const usage = path && started ? probe?.usage({ worktreePath: path, since: started.at, until }) : undefined;
  store.append(
    newEvent(
      state.spec.id,
      'telemetry-recorded',
      {
        dispatchId: ref.dispatchId,
        role,
        requestedModel: ref.requested?.model,
        launchedModel: receipt?.model ?? usage?.model,
        usage: usage ?? 'unknown',
        ...(started ? { wallMs: now() - Date.parse(started.at) } : {}),
      },
      new Date(now()).toISOString(),
    ),
  );
}

/**
 * Starts a reviewer with its intent recorded first (seen live: Orca created the reviewer but reported its
 * start as outcome-unknown, so a later wake recovers it by key). Returns the action line for the tick.
 */
export async function dispatchReviewer(
  store: GoalRepository,
  runtime: RuntimeAdapter,
  now: () => number,
  request: { goalId: string; repoPath: string; baseCommit: string; commit: string; reasons: string[]; runId: string },
  label: { started: (dispatchId: string) => string; unknown: string },
): Promise<string> {
  const { goalId, commit } = request;
  const record = (type: GoalEventType, data: unknown) =>
    store.append(newEvent(goalId, type, data, new Date(now()).toISOString()));
  const key = randomUUID();
  record('review-intended', { key, commit });
  try {
    const reviewer = await runtime.startReviewer!({
      repoPath: request.repoPath,
      goalId,
      baseCommit: request.baseCommit,
      commit,
      reasons: request.reasons,
      idempotencyKey: key,
      runId: request.runId,
    });
    record('review-dispatched', {
      dispatchId: reviewer.dispatchId,
      runId: reviewer.runId,
      key,
      commit,
      worktreeId: reviewer.worktreeId,
      terminal: reviewer.terminal,
      requested: reviewer.requested,
    });
    return label.started(reviewer.dispatchId);
  } catch (error) {
    return `${label.unknown}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
