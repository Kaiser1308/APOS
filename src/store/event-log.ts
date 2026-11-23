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

type Line<E = GoalEvent> = { event: E; prev: string; hash: string };
const GENESIS = '0'.repeat(64);
const chain = (prev: string, event: unknown) =>
  createHash('sha256').update(prev).update(JSON.stringify(event)).digest('hex');

/** Parses and verifies complete JSONL lines; any corrupt line or break in the chain is reported as tampering. */
export function verifyChain<E = GoalEvent>(goalId: string, complete: string[]): Line<E>[] {
  const lines: Line<E>[] = [];
  let prev = GENESIS;
  for (const [index, text] of complete.entries()) {
    let line: Line<E>;
    try {
      line = JSON.parse(text) as Line<E>;
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
 * One append-only, fsync'd, hash-chained JSONL file. A torn final line (crash mid-write) is dropped on
 * read; any other break in the chain is reported as tampering.
 */
export class ChainFile<E> {
  constructor(
    private readonly path: string,
    private readonly name: string,
  ) {}

  private lines(repair = true): Line<E>[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, 'utf8');
    const parts = raw.split('\n');
    const complete = parts.slice(0, -1);
    const torn = raw.endsWith('\n') ? '' : parts.at(-1)!;
    if (torn && repair) truncateSync(this.path, Buffer.byteLength(raw) - Buffer.byteLength(torn));
    return verifyChain<E>(this.name, complete);
  }

  read(): E[] {
    return this.lines().map(line => line.event);
  }

  /** Like `read`, but never writes: a torn final line is ignored, not truncated. */
  peek(): E[] {
    return this.lines(false).map(line => line.event);
  }

  append(event: E): void {
    const prev = this.lines().at(-1)?.hash ?? GENESIS;
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, `${JSON.stringify({ event, prev, hash: chain(prev, event) } satisfies Line<E>)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** One chained log per Goal under `events/`. */
export class EventLog {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'events'), { recursive: true });
  }

  private file(goalId: string): ChainFile<GoalEvent> {
    if (!/^GOAL-[A-Z0-9-]+$/.test(goalId)) throw new Error('Invalid Goal identity');
    return new ChainFile(join(this.dir, 'events', `${goalId}.jsonl`), goalId);
  }

  goals(): string[] {
    return readdirSync(join(this.dir, 'events'))
      .filter(name => /^GOAL-[A-Z0-9-]+\.jsonl$/.test(name))
      .map(name => name.slice(0, -'.jsonl'.length))
      .sort();
  }

  read(goalId: string): GoalEvent[] {
    return this.file(goalId).read();
  }

  append(event: GoalEvent): void {
    this.file(event.goalId).append(event);
  }
}
