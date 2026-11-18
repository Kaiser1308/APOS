import { createHash } from 'node:crypto';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../domain/errors.js';
import type { GoalStatus } from '../domain/transitions.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import { buildInbox, type InboxKind } from './inbox.js';

export type HumanInboxKind = InboxKind | 'awaiting-approval' | 'awaiting-selection';
export type HumanInboxItem = { goalId: string; kind: HumanInboxKind; detail: string; at?: string };

const VALID_STATUSES: Set<string> = new Set<GoalStatus>([
  'draft',
  'approved',
  'selected',
  'planned',
  'ready',
  'executing',
  'blocked',
  'verified',
  'closed',
  'stopped',
]);

/** Max minutes since the last controller tick before `inbox --wait` / `goal wait` warns that no controller is running. */
export const CONTROLLER_STALE_MINUTES = 2;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** True when a live controller process holds the lease or ticked within CONTROLLER_STALE_MINUTES. */
export function controllerActive(home: string, now: number = Date.now()): boolean {
  for (const name of ['controller.lease', 'controller.heartbeat']) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; at?: string };
      if (typeof data.pid !== 'number' || !pidAlive(data.pid)) continue;
      if (name === 'controller.lease') return true;
      if (data.at && now - Date.parse(data.at) <= CONTROLLER_STALE_MINUTES * 60_000) return true;
    } catch {
      /* ignore torn file */
    }
  }
  return false;
}

export function parseDurationMs(raw: string | undefined, defaultMs = 300_000): number {
  if (!raw) return defaultMs;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) throw new UserError(`Invalid duration "${raw}": use a number with optional ms, s, m or h (e.g. 30s, 5m)`);
  const value = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.max(1, Math.round(value * mult));
}

export function buildHumanInbox(repo: GoalRepository): HumanInboxItem[] {
  const gates: HumanInboxItem[] = [];
  for (const state of repo.listGoals()) {
    const events = repo.events(state.spec.id);
    if (state.status === 'draft')
      gates.push({
        goalId: state.spec.id,
        kind: 'awaiting-approval',
        detail: 'gate A: approve the Goal and its appetite',
        at: [...events].reverse().find(item => item.type === 'goal-drafted' || item.type === 'goal-revised')?.at,
      });
    if (state.status === 'approved')
      gates.push({
        goalId: state.spec.id,
        kind: 'awaiting-selection',
        detail: 'gate B: select this Goal to run next',
        at: [...events].reverse().find(item => item.type === 'goal-approved')?.at,
      });
  }
  return [...gates, ...buildInbox(repo)];
}

export const itemCursorId = (item: HumanInboxItem): string =>
  `c_${createHash('sha1')
    .update(`${item.goalId}|${item.kind}|${item.at ?? ''}|${item.detail}`)
    .digest('hex')
    .slice(0, 12)}`;

export function filterInboxSince(items: HumanInboxItem[], since?: string): { fresh: HumanInboxItem[]; cursor: string } {
  if (!since || since === 'none') {
    const ids = items.map(itemCursorId);
    return { fresh: items, cursor: ids.join(',') || 'none' };
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(since.trim()) && !since.includes(',')) {
    const cut = Date.parse(since.trim());
    const fresh = items.filter(item => !item.at || Date.parse(item.at) > cut);
    return { fresh, cursor: items.map(itemCursorId).join(',') || 'none' };
  }
  const seen = new Set(
    since
      .split(',')
      .map(part => part.trim())
      .filter(Boolean),
  );
  const fresh = items.filter(item => !seen.has(itemCursorId(item)));
  // The cursor lists only the items waiting now, so it stays as small as the inbox and an item that is
  // resolved and later returns is reported again.
  return { fresh, cursor: items.map(itemCursorId).join(',') || 'none' };
}

/** Watches `<home>/events` (with a 100ms polling fallback on Windows) until `check()` returns a value or `timeoutMs` elapses. */
export async function watchEvents<T>(
  home: string,
  timeoutMs: number,
  check: () => T | undefined,
): Promise<T | undefined> {
  const immediate = check();
  if (immediate !== undefined) return immediate;
  return new Promise<T | undefined>(resolveWait => {
    let settled = false;
    const watchers: FSWatcher[] = [];
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      resolveWait(value);
    };
    const probe = () => {
      if (settled) return;
      try {
        const hit = check();
        if (hit !== undefined) finish(hit);
      } catch {
        /* ignore transient read error */
      }
    };
    for (const dir of [home, join(home, 'events')]) {
      if (!existsSync(dir)) continue;
      try {
        watchers.push(watch(dir, () => probe()));
      } catch {
        /* polling covers platforms where fs.watch is unavailable */
      }
    }
    const poll = setInterval(probe, 100);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
  });
}

export function parseTargetStatuses(until: string): Set<GoalStatus> {
  const list = until
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  if (!list.length) throw new UserError('--until requires at least one Goal status');
  for (const status of list) {
    if (!VALID_STATUSES.has(status))
      throw new UserError(`Unknown Goal status "${status}": use ${[...VALID_STATUSES].join(', ')}`);
  }
  return new Set(list as GoalStatus[]);
}

export function readOnlyRepo(home: string): ReadOnlyJournal {
  return new ReadOnlyJournal(home);
}
