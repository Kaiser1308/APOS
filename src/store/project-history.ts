import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { GoalEvent } from '../domain/transitions.js';

export type DocumentUpdate = { path: string; content: string };
export type HistoryRef = { commit: string; eventId: string; eventFile: string };

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function assertGitRoot(repoPath: string): string {
  const repo = resolve(repoPath);
  let root: string;
  try { root = resolve(git(repo, ['rev-parse', '--show-toplevel'])); }
  catch { throw new Error(`Not a Git repository: ${repo}`); }
  if (root.toLowerCase() !== repo.toLowerCase()) throw new Error(`Path must be a Git project root: ${repo}`);
  return repo;
}

export function committedGoalEvents(repoPath: string, goalId: string): GoalEvent[] {
  const repo = assertGitRoot(repoPath);
  let content: string;
  try {
    content = git(repo, ['show', `HEAD:.apos/goals/${goalId}/events.jsonl`]);
  } catch { return []; }
  return content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as GoalEvent);
}

export function withHistoryLock<T>(repo: string, action: () => T): T {
  const aposDir = join(repo, '.apos');
  mkdirSync(aposDir, { recursive: true });
  const lock = join(aposDir, '.history.lock');
  const deadline = Date.now() + 15_000;
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`APOS history lock is busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { return action(); } finally { rmdirSync(lock); }
}

export class ProjectHistory {
  async record(repoPath: string, goalId: string, event: GoalEvent, documents: DocumentUpdate[] = []): Promise<HistoryRef> {
    return this.recordSync(repoPath, goalId, event, documents);
  }

  recordSync(repoPath: string, goalId: string, event: GoalEvent, documents: DocumentUpdate[] = []): HistoryRef {
    const repo = assertGitRoot(repoPath);
    return withHistoryLock(repo, () => this.recordLocked(repo, goalId, event, documents));
  }

  recordUnderLock(repoPath: string, goalId: string, event: GoalEvent, documents: DocumentUpdate[] = []): HistoryRef {
    return this.recordLocked(assertGitRoot(repoPath), goalId, event, documents);
  }

  private recordLocked(repo: string, goalId: string, event: GoalEvent, documents: DocumentUpdate[]): HistoryRef {
    if (!/^GOAL-[A-Z0-9-]+$/.test(goalId) || event.goalId !== goalId || !event.id) throw new Error('Invalid Goal/event identity');
    const goalDir = join(repo, '.apos', 'goals', goalId);
    mkdirSync(goalDir, { recursive: true });
    const eventFile = join(goalDir, 'events.jsonl');
    const old = existsSync(eventFile) ? readFileSync(eventFile, 'utf8') : '';
    const prior = old.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as GoalEvent);
    const committed = committedGoalEvents(repo, goalId);
    if (JSON.stringify(prior) !== JSON.stringify(committed)) throw new Error('Uncommitted APOS Goal history requires reconciliation before another event');
    if (prior.some(item => item.id === event.id)) {
      return { commit: git(repo, ['log', '-1', '--format=%H', '--', relative(repo, eventFile)]), eventId: event.id, eventFile };
    }
    const files = [eventFile];
    for (const doc of documents) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(doc.path) && !/^packages\/WP-[A-Z0-9-]+\.md$/.test(doc.path)) throw new Error(`Invalid document path: ${doc.path}`);
      const path = join(goalDir, doc.path);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, doc.content, 'utf8');
      files.push(path);
    }
    writeFileSync(eventFile, `${old}${JSON.stringify(event)}\n`, 'utf8');
    const paths = files.map(path => relative(repo, path));
    git(repo, ['add', '--', ...paths]);
    git(repo, ['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '--only', '-m', `apos: ${goalId} ${event.type}`, '--', ...paths]);
    return { commit: git(repo, ['rev-parse', 'HEAD']), eventId: event.id, eventFile };
  }
}
