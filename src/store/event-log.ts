import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { GoalEvent } from '../domain/transitions.js';

/**
 * Per-project controller directory, outside the managed repo so owners working in the repo or its
 * worktrees do not edit or commit controller state. Override the root with APOS_HOME.
 */
export function controllerHome(
  repoPath: string,
  root: string = process.env.APOS_HOME ?? join(homedir(), '.apos'),
): string {
  const repo = resolve(repoPath);
  const key = createHash('sha256').update(repo.toLowerCase()).digest('hex').slice(0, 12);
  return join(
    root,
    'projects',
    `${basename(repo)
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_')}-${key}`,
  );
}

type Line = { event: GoalEvent; prev: string; hash: string };
const GENESIS = '0'.repeat(64);
const chain = (prev: string, event: GoalEvent) =>
  createHash('sha256').update(prev).update(JSON.stringify(event)).digest('hex');

/** Parses and verifies complete JSONL lines; any corrupt line or break in the chain is reported as tampering. */
export function verifyChain(goalId: string, complete: string[]): Line[] {
  const lines: Line[] = [];
  let prev = GENESIS;
  for (const [index, text] of complete.entries()) {
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch {
      throw new Error(`APOS event log ${goalId} is corrupt at line ${index + 1}`);
    }
    if (line.prev !== prev || line.hash !== chain(prev, line.event))
      throw new Error(`APOS event log ${goalId} was modified at line ${index + 1}`);
    lines.push(line);
    prev = line.hash;
  }
  return lines;
}

/**
 * Append-only, fsync'd, hash-chained event log: one JSONL file per Goal. A torn final line (crash
 * mid-write) is dropped on read; any other break in the chain is reported as tampering.
 */
export class EventLog {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'events'), { recursive: true });
  }

  private file(goalId: string): string {
    if (!/^GOAL-[A-Z0-9-]+$/.test(goalId)) throw new Error('Invalid Goal identity');
    return join(this.dir, 'events', `${goalId}.jsonl`);
  }

  goals(): string[] {
    return readdirSync(join(this.dir, 'events'))
      .filter(name => /^GOAL-[A-Z0-9-]+\.jsonl$/.test(name))
      .map(name => name.slice(0, -'.jsonl'.length))
      .sort();
  }

  private lines(goalId: string): Line[] {
    const path = this.file(goalId);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const parts = raw.split('\n');
    const complete = raw.endsWith('\n') ? parts.slice(0, -1) : parts.slice(0, -1);
    const torn = raw.endsWith('\n') ? '' : parts.at(-1)!;
    if (torn) truncateSync(path, Buffer.byteLength(raw) - Buffer.byteLength(torn));
    return verifyChain(goalId, complete);
  }

  read(goalId: string): GoalEvent[] {
    return this.lines(goalId).map(line => line.event);
  }

  append(event: GoalEvent): void {
    const prior = this.lines(event.goalId);
    const prev = prior.at(-1)?.hash ?? GENESIS;
    const fd = openSync(this.file(event.goalId), 'a');
    try {
      writeSync(fd, `${JSON.stringify({ event, prev, hash: chain(prev, event) } satisfies Line)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
