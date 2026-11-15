import type { RuntimeProfile, RuntimeRef } from '../../domain/runtime-refs.js';
import type { RuntimeObservation } from '../../ports/runtime.js';
import { SCREENS } from '../screens.js';

/** True when the role's profile now names another agent or model than the dispatch runs; an unknown running profile is not a change. */
export function profileChanged(
  running: { agent?: string; model?: string } | undefined,
  wanted: RuntimeProfile,
): boolean {
  if (!running?.agent) return false;
  return running.agent !== wanted.agent || (running.model ?? undefined) !== (wanted.model ?? undefined);
}

export const worktreePath = (worktreeId: string | undefined): string | undefined =>
  worktreeId?.includes('::') ? worktreeId.slice(worktreeId.indexOf('::') + 2) : undefined;

export function parseOrcaResult(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Orca returned non-JSON output');
  }
  if (!parsed || typeof parsed !== 'object' || !('ok' in parsed) || (parsed as { ok: unknown }).ok !== true) {
    throw new Error('Orca operation failed or has unknown outcome');
  }
  const result = (parsed as { result?: unknown }).result;
  if (!result || typeof result !== 'object') throw new Error('Orca result missing');
  return result as Record<string, unknown>;
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Orca response missing ${label}`);
  return value;
}

/** run-create answers `{ run: { id } }` in older Orca and `{ runId }` in 1.4.254. */
export function runIdOf(created: Record<string, unknown>): string {
  return id(created.runId ?? object(created.run).id, 'Run ID');
}

export function extractStartedRef(started: Record<string, unknown>, repoPath: string): RuntimeRef {
  const effects = Array.isArray(started.effects) ? started.effects.map(object) : [];
  const terminal = effects.find(effect => effect.kind === 'terminal' && effect.role === 'agent');
  const worktree = effects.find(effect => effect.kind === 'worktree');
  const terminalId =
    typeof terminal?.id === 'string'
      ? terminal.id
      : typeof started.terminal === 'string'
        ? started.terminal
        : undefined;
  const worktreeId =
    typeof worktree?.id === 'string'
      ? worktree.id
      : typeof started.workspace === 'string'
        ? started.workspace
        : undefined;
  return {
    runId: id(started.runId, 'Run ID'),
    taskId: id(started.taskId, 'Task ID'),
    dispatchId: id(started.dispatchId, 'Dispatch ID'),
    owner: 'lead',
    repoPath,
    terminal: terminalId,
    ...(worktreeId ? { worktreeId } : {}),
  };
}

export function interpretWorkerShow(shown: Record<string, unknown>): RuntimeObservation['state'] {
  const dispatchStatus = object(shown.dispatch).status;
  if (dispatchStatus === 'completed' || dispatchStatus === 'failed') return 'settled';
  const liveness = object(object(shown.projection).liveness).verdict;
  return liveness === 'live' ? 'live' : 'unverifiable';
}

/** Minutes of idleness from worker-show (`activity: idle`, `lastActivity: "10m ago"`); undefined when the agent is not idle or Orca gives no age. */
export function idleMinutesFrom(shown: Record<string, unknown>): number | undefined {
  const where = shown.activity !== undefined ? shown : object(shown.projection);
  if (where.activity !== 'idle' || typeof where.lastActivity !== 'string') return undefined;
  const match = /^(\d+)\s*(s|m|h|d)/.exec(where.lastActivity.trim());
  if (!match) return undefined;
  return Number(match[1]) * { s: 1 / 60, m: 1, h: 60, d: 1440 }[match[2] as 's' | 'm' | 'h' | 'd'];
}

/**
 * The agent terminal of a recovered dispatch. Orca 1.4.255 answers `assigneeHandle` (seen in a live dispatch record);
 * older builds answered `assignee_handle`; the worker record also names it.
 */
export function assigneeOf(dispatch: Record<string, unknown>, worker: Record<string, unknown>): string | undefined {
  const value = dispatch.assigneeHandle ?? dispatch.assignee_handle ?? worker.agentTerminalHandle;
  return typeof value === 'string' && value ? value : undefined;
}

/** The Codex check behind `composerPending`, on the visible tail of a Codex TUI (see `screens.ts`). */
export function composerHasUnsentBrief(lines: string[]): boolean {
  return SCREENS.codex.unsentBrief(lines);
}
