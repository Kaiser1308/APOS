import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export class ProjectHistory {
  async record(repoPath: string, goalId: string, event: GoalEvent, documents: DocumentUpdate[] = []): Promise<HistoryRef> {
    return this.recordSync(repoPath, goalId, event, documents);
  }

  recordSync(repoPath: string, goalId: string, event: GoalEvent, documents: DocumentUpdate[] = []): HistoryRef {
    const repo = assertGitRoot(repoPath);
    if (!/^GOAL-[A-Z0-9-]+$/.test(goalId) || event.goalId !== goalId || !event.id) throw new Error('Invalid Goal/event identity');
    const goalDir = join(repo, '.apos', 'goals', goalId);
    mkdirSync(goalDir, { recursive: true });
    const eventFile = join(goalDir, 'events.jsonl');
    const old = existsSync(eventFile) ? readFileSync(eventFile, 'utf8') : '';
    const prior = old.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as GoalEvent);
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
