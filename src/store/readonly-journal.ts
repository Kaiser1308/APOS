import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyEvent, type GoalEvent, type GoalState } from '../domain/transitions.js';
import { verifyChain } from './event-log.js';
import type { GoalRepository } from '../ports/goal-repository.js';

const GOAL_FILE = /^GOAL-[A-Z0-9-]+\.jsonl$/;

/**
 * Reads the controller's event logs without touching them: no directory is created, no torn final line
 * is truncated, no lock is taken and no SQLite index is rebuilt. The controller may be appending while
 * this reads, so a final line without its newline is a write in progress and is ignored.
 *
 * Each Goal is loaded on its own. A Goal whose hash chain is broken (or whose events no longer apply)
 * is reported in `failures` and left out of `listGoals`; the other Goals are unaffected.
 */
export class ReadOnlyJournal implements GoalRepository {
  private readonly loaded = new Map<string, { events: GoalEvent[]; state?: GoalState }>();
  readonly failures = new Map<string, string>();

  constructor(readonly home: string) {
    const dir = join(home, 'events');
    const names = existsSync(dir)
      ? readdirSync(dir)
          .filter(name => GOAL_FILE.test(name))
          .sort()
      : [];
    for (const name of names) {
      const goalId = name.slice(0, -'.jsonl'.length);
      try {
        const raw = readFileSync(join(dir, name), 'utf8');
        const complete = raw.split('\n').slice(0, -1);
        const events = verifyChain(goalId, complete).map(line => line.event);
        const state = events.reduce<GoalState | undefined>((current, event) => applyEvent(current, event), undefined);
        this.loaded.set(goalId, { events, state });
      } catch (error) {
        this.failures.set(goalId, error instanceof Error ? error.message.split('\n')[0] : String(error));
      }
    }
  }

  /** Every Goal that has a log file, including those that failed to load. */
  goalIds(): string[] {
    return [...new Set([...this.loaded.keys(), ...this.failures.keys()])].sort();
  }
  getGoal(id: string): GoalState | undefined {
    return this.loaded.get(id)?.state;
  }
  listGoals(): GoalState[] {
    return [...this.loaded.values()].flatMap(item => item.state ?? []);
  }
  events(id: string): GoalEvent[] {
    return this.loaded.get(id)?.events ?? [];
  }
  append(): never {
    throw new Error('The UI journal is read-only');
  }
  artifactRoot(): string {
    return process.env.APOS_ARTIFACTS ?? join(this.home, 'artifacts');
  }
  sourcePath(goalId: string, version: number): string {
    return join(this.home, 'sources', goalId, `v${version}.md`);
  }
}
