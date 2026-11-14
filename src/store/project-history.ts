import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import type { GoalEvent } from '../domain/transitions.js';

export type DocumentUpdate = { path: string; content: string };

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function assertGitRoot(repoPath: string): string {
  const repo = resolve(repoPath);
  let root: string;
  try {
    root = resolve(git(repo, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new Error(`Not a Git repository: ${repo}`);
  }
  if (root.toLowerCase() !== repo.toLowerCase()) throw new Error(`Path must be a Git project root: ${repo}`);
  return repo;
}

/** Events committed by APOS v1, which kept its event log inside the managed repo. Used only to migrate. */
export function legacyGoalEvents(repoPath: string, goalId: string): GoalEvent[] {
  const repo = assertGitRoot(repoPath);
  let content: string;
  try {
    content = git(repo, ['show', `HEAD:.apos/goals/${goalId}/events.jsonl`]);
  } catch {
    return [];
  }
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as GoalEvent);
}

export function legacyGoalIds(repoPath: string): string[] {
  const repo = assertGitRoot(repoPath);
  try {
    return git(repo, ['ls-tree', '--name-only', 'HEAD', '.apos/goals/'])
      .split(/\r?\n/)
      .map(line => line.split('/').pop()!)
      .filter(name => /^GOAL-[A-Z0-9-]+$/.test(name));
  } catch {
    return [];
  }
}

/** A cross-process lock: a directory whose owner file names a live PID; dead owners' locks are reclaimed. */
export function withLock<T>(lockParent: string, action: () => T): T {
  mkdirSync(lockParent, { recursive: true });
  const lock = join(lockParent, '.apos.lock');
  const ownerFile = join(lock, 'owner.json');
  const token = randomUUID();
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      mkdirSync(lock);
      writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > 2_000) {
          const owner = existsSync(ownerFile) ? (JSON.parse(readFileSync(ownerFile, 'utf8')) as { pid?: number }) : {};
          let alive = true;
          if (typeof owner.pid === 'number') {
            try {
              process.kill(owner.pid, 0);
            } catch (reason) {
              alive = (reason as NodeJS.ErrnoException).code !== 'ESRCH';
            }
          } else alive = false;
          if (!alive) {
            if (existsSync(ownerFile)) unlinkSync(ownerFile);
            rmdirSync(lock);
            continue;
          }
        }
      } catch {
        /* Another process changed the lock; wait and retry. */
      }
      if (Date.now() >= deadline) throw new Error(`APOS lock is busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return action();
  } finally {
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as { token?: string };
    if (owner.token !== token) throw new Error('APOS lock ownership changed');
    unlinkSync(ownerFile);
    rmdirSync(lock);
  }
}

const docPath = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.md|packages\/WP-[A-Z0-9-]+\.md)$/;

/**
 * Writes readable Goal documents into `.apos/goals/<id>/` and commits only those paths, leaving the
 * user's staged and dirty files alone. Returns the new commit, or undefined when nothing changed.
 */
export function commitGoalDocuments(
  repoPath: string,
  goalId: string,
  documents: DocumentUpdate[],
  message: string,
): string | undefined {
  const repo = assertGitRoot(repoPath);
  if (!/^GOAL-[A-Z0-9-]+$/.test(goalId)) throw new Error('Invalid Goal identity');
  const goalDir = join(repo, '.apos', 'goals', goalId);
  const paths: string[] = [];
  for (const doc of documents) {
    if (!docPath.test(doc.path)) throw new Error(`Invalid document path: ${doc.path}`);
    const path = join(goalDir, doc.path);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, doc.content, 'utf8');
    paths.push(relative(repo, path));
  }
  if (!paths.length) return undefined;
  git(repo, ['add', '--', ...paths]);
  if (!git(repo, ['diff', '--cached', '--name-only', '--', ...paths])) return undefined;
  git(repo, [
    '-c',
    'user.name=APOS',
    '-c',
    'user.email=apos@local.invalid',
    'commit',
    '--only',
    '-m',
    message,
    '--',
    ...paths,
  ]);
  return git(repo, ['rev-parse', 'HEAD']);
}
