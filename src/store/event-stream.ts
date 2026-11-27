import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { join } from 'node:path';
import { ChainFile, verifyChain } from './event-log.js';
import { withLock } from './project-history.js';

const eventSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  at: z.string(),
  data: z.unknown().optional(),
  goalId: z.string().optional(),
});
const entrySchema = z.object({ seq: z.number().int().positive(), id: z.string().min(1), event: eventSchema });
const headerSchema = z.object({ generation: z.string().min(1) });
type Event = z.infer<typeof eventSchema>;
type Entry = z.infer<typeof entrySchema>;
type Header = z.infer<typeof headerSchema>;
const parseEvent = (value: unknown): Event => eventSchema.parse(value);

type Options = { initialize?: boolean; generation?: string; anchor?: string };

/** Index is durable state, not a rebuildable cache. */
export function readEventStream(home: string, since: number, options: Options = {}) {
  return withLock(home, () => {
    const dir = join(home, 'events');
    const path = join(home, 'stream.jsonl');
    const index = new ChainFile<Header | Entry>(path, 'stream');
    if (!existsSync(path)) {
      if (!options.initialize || since !== 0)
        throw new Error('Event index missing; explicitly initialize and reset cursor');
      index.append({ generation: randomUUID() });
      const fd = openSync(home, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else if (options.initialize) throw new Error('Event index exists; initialization refused');
    const raw = readFileSync(path, 'utf8');
    if (!raw.endsWith('\n')) throw new Error('Event index is torn or corrupt; restore it and reset cursor');
    const lines = verifyChain<Header | Entry>('stream', raw.split('\n').slice(0, -1));
    const header = headerSchema.parse(lines[0]?.event);
    const entries: Entry[] = [];
    for (const line of lines.slice(1)) {
      const entry = entrySchema.parse(line.event);
      if (entry.seq !== entries.length + 1 || entry.id !== entry.event.id)
        throw new Error('Invalid event index sequence');
      entries.push(entry);
    }
    const ids = new Set(entries.map(entry => entry.id));
    if (ids.size !== entries.length) throw new Error('Duplicate event index id');
    if (
      (since > 0 || options.generation !== undefined || options.anchor !== undefined) &&
      (options.generation !== header.generation || since > entries.length || options.anchor !== lines[since]?.hash)
    )
      throw new Error('Event cursor does not match index; reset cursor');
    const names = existsSync(dir)
      ? readdirSync(dir)
          .filter(name => name === '_project.jsonl' || /^GOAL-[A-Z0-9-]+\.jsonl$/.test(name))
          .sort()
      : [];
    const available = new Map<string, Event>();
    for (const name of names) {
      for (const value of new ChainFile<unknown>(join(dir, name), name).read()) {
        const event = parseEvent(value);
        if (available.has(event.id)) throw new Error(`Duplicate event id: ${event.id}`);
        available.set(event.id, event);
      }
    }
    for (const entry of entries) {
      if (JSON.stringify(available.get(entry.id)) !== JSON.stringify(entry.event))
        throw new Error(`Event index source missing or changed: ${entry.id}`);
    }
    for (const event of available.values()) {
      if (!ids.has(event.id)) {
        const entry = { seq: entries.length + 1, id: event.id, event };
        index.append(entry);
        entries.push(entry);
      }
    }
    const finalRaw = readFileSync(path, 'utf8');
    const finalLines = verifyChain<Header | Entry>('stream', finalRaw.split('\n').slice(0, -1));
    return {
      generation: header.generation,
      anchor: finalLines.at(-1)!.hash,
      events: entries.filter(entry => entry.seq > since),
    };
  });
}
