import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ChainFile, verifyChain } from './event-log.js';
import { withLock } from './project-history.js';

import { InvariantError, UserError } from '../domain/errors.js';
import {
  parseStreamEntry,
  parseStreamEvent,
  parseStreamHeader,
  type StreamEntry,
  type StreamEvent,
  type StreamHeader,
  type StreamOptions,
} from '../domain/event-stream.js';

function parseStored<T>(value: unknown, parser: (value: unknown) => T, name: string): T {
  try {
    return parser(value);
  } catch (cause) {
    throw new InvariantError(`Invalid ${name}`, { cause });
  }
}

function verifyIndex(lines: string[]) {
  try {
    return verifyChain<StreamHeader | StreamEntry>('stream', lines);
  } catch (cause) {
    throw new InvariantError(cause instanceof Error ? cause.message : 'Invalid event index chain', { cause });
  }
}

function readJournal(path: string, name: string): unknown[] {
  try {
    return new ChainFile<unknown>(path, name).read();
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') throw cause;
    throw new InvariantError(cause instanceof Error ? cause.message : `Invalid journal ${name}`, { cause });
  }
}

/** Index is durable state, not a rebuildable cache. */
export function readEventStream(home: string, since: number, options: StreamOptions = {}) {
  if (!Number.isSafeInteger(since) || since < 0) throw new UserError('--since must be a non-negative safe integer');
  return withLock(home, () => {
    const dir = join(home, 'events');
    const path = join(home, 'stream.jsonl');
    const index = new ChainFile<StreamHeader | StreamEntry>(path, 'stream');
    if (!existsSync(path)) {
      if (!options.initialize || since !== 0)
        throw new UserError('Event index missing; explicitly initialize and reset cursor');
      index.append({ generation: randomUUID() });
      // Windows does not allow Node to open a directory for fsync. File data is flushed above;
      // its directory entry must be included in a coordinated backup on every platform.
      if (process.platform !== 'win32') {
        const fd = openSync(home, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    } else if (options.initialize) throw new UserError('Event index exists; initialization refused');
    const raw = readFileSync(path, 'utf8');
    if (!raw.endsWith('\n')) throw new InvariantError('Event index is torn or corrupt; restore it and reset cursor');
    const lines = verifyIndex(raw.split('\n').slice(0, -1));
    const header = parseStored(lines[0]?.event, parseStreamHeader, 'event index header');
    const entries: StreamEntry[] = [];
    for (const line of lines.slice(1)) {
      const entry = parseStored(line.event, parseStreamEntry, 'event index entry');
      if (entry.seq !== entries.length + 1 || entry.id !== entry.event.id)
        throw new InvariantError('Invalid event index sequence');
      entries.push(entry);
    }
    const ids = new Set(entries.map(entry => entry.id));
    if (ids.size !== entries.length) throw new InvariantError('Duplicate event index id');
    if (
      (since > 0 || options.generation !== undefined || options.anchor !== undefined) &&
      (options.generation !== header.generation || since > entries.length || options.anchor !== lines[since]?.hash)
    )
      throw new UserError('Event cursor does not match index; reset cursor');
    const names = existsSync(dir)
      ? readdirSync(dir)
          .filter(name => name === '_project.jsonl' || /^GOAL-[A-Z0-9-]+\.jsonl$/.test(name))
          .sort()
      : [];
    const available = new Map<string, StreamEvent>();
    for (const name of names) {
      for (const value of readJournal(join(dir, name), name)) {
        const event = parseStored(value, parseStreamEvent, 'journal event');
        if (available.has(event.id)) throw new InvariantError(`Duplicate event id: ${event.id}`);
        available.set(event.id, event);
      }
    }
    for (const entry of entries) {
      if (JSON.stringify(available.get(entry.id)) !== JSON.stringify(entry.event))
        throw new InvariantError(`Event index source missing or changed: ${entry.id}`);
    }
    const pending: StreamEntry[] = [];
    for (const event of available.values()) {
      if (!ids.has(event.id)) {
        const entry = { seq: entries.length + pending.length + 1, id: event.id, event };
        pending.push(entry);
      }
    }
    index.appendMany(pending);
    for (const entry of pending) entries.push(entry);
    const finalRaw = readFileSync(path, 'utf8');
    const finalLines = verifyIndex(finalRaw.split('\n').slice(0, -1));
    return {
      generation: header.generation,
      anchor: finalLines.at(-1)!.hash,
      events: entries
        .filter(entry => entry.seq > since)
        .map(entry => ({ ...entry, anchor: finalLines[entry.seq]!.hash })),
    };
  });
}
