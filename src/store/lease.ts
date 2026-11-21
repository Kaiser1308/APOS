import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * One controller tick at a time per controller home. Seen live: a pilot loop that was thought stopped
 * kept ticking beside a new one; both gated the same commit at once and one saw a false new failure.
 * Returns undefined, without running `fn`, while another live process holds the lease.
 */
export async function withControllerLease<T>(
  home: string,
  fn: () => Promise<T>,
  maxAgeMs = 2 * 60 * 60_000,
): Promise<{ ran: true; value: T } | { ran: false; holder: number }> {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'controller.lease');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const now = new Date().toISOString();
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx' });
      writeFileSync(
        join(home, 'controller.heartbeat'),
        JSON.stringify({ pid: process.pid, at: now, terminal: process.env.ORCA_TERMINAL_HANDLE }),
      );
      try {
        return { ran: true, value: await fn() };
      } finally {
        rmSync(path, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: { pid?: number; at?: string } = {};
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* torn write: treat as stale */
      }
      const fresh = holder.at && Date.now() - Date.parse(holder.at) < maxAgeMs;
      if (holder.pid && holder.pid !== process.pid && alive(holder.pid) && fresh)
        return { ran: false, holder: holder.pid };
      rmSync(path, { force: true });
    }
  }
  throw new Error('controller lease could not be acquired');
}

/**
 * The controller watch that ticked this project lately and still runs: the pid of its last tick is alive and that
 * tick is younger than `maxAgeMs` (longer than the slowest watch interval). Undefined when none does, or for this
 * process. `terminal` is the Orca terminal it runs in, which coordinates every Run the controller created.
 */
export function liveController(
  home: string,
  maxAgeMs = 10 * 60_000,
): { pid: number; at: string; terminal?: string } | undefined {
  let beat: { pid?: unknown; at?: unknown; terminal?: unknown };
  try {
    beat = JSON.parse(readFileSync(join(home, 'controller.heartbeat'), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof beat.pid !== 'number' || typeof beat.at !== 'string' || beat.pid === process.pid) return undefined;
  if (!(Date.now() - Date.parse(beat.at) < maxAgeMs) || !alive(beat.pid)) return undefined;
  return { pid: beat.pid, at: beat.at, ...(typeof beat.terminal === 'string' ? { terminal: beat.terminal } : {}) };
}
