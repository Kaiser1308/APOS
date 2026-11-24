import { UserError } from '../domain/errors.js';

/**
 * The time the hotfix deadline is read at: now, unless `APOS_NOW` (an ISO date) says otherwise. It exists so a test or a
 * demo can look at "a day later" without waiting a day. Only what reads a deadline asks it (`hotfix`, `hotfix list`,
 * `inbox`, `goal show`): events, the time budget of a Goal and the gates keep the real clock.
 */
export function clockOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.APOS_NOW?.trim() || undefined;
}

export function currentTime(env: NodeJS.ProcessEnv = process.env): string {
  const set = clockOverride(env);
  if (!set) return new Date().toISOString();
  const at = Date.parse(set);
  if (Number.isNaN(at)) throw new UserError(`APOS_NOW is "${set}": it must be a date such as 2026-11-25T09:00:00Z`);
  return new Date(at).toISOString();
}
