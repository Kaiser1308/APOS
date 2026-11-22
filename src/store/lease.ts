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
 * One gate at a time per project home. Seen live: two gates ran the same commit at once and one saw a false new
 * failure. Returns without running `fn` while another live process holds the lease; a lease left by a dead or
 * very old process is taken over.
 */
export async function withGateLease<T>(
  home: string,
  fn: () => Promise<T>,
  maxAgeMs = 2 * 60 * 60_000,
): Promise<{ ran: true; value: T } | { ran: false; holder: number }> {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'gate.lease');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
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
  throw new Error('gate lease could not be acquired');
}
