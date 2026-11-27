import { mkdtempSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChainFile } from './event-log.js';
import { readEventStream } from './event-stream.js';

describe('event stream', () => {
  it('retains sequence positions as events arrive in different goal logs', () => {
    const home = mkdtempSync(join(tmpdir(), 'apos-stream-'));
    mkdirSync(join(home, 'events'));
    const a = new ChainFile(join(home, 'events', 'GOAL-A.jsonl'), 'GOAL-A');
    const b = new ChainFile(join(home, 'events', 'GOAL-B.jsonl'), 'GOAL-B');
    a.append({ id: 'a', goalId: 'GOAL-A', type: 'example', at: '2025-01-01', data: {} });
    expect(() => readEventStream(home, 0)).toThrow(/initialize/);
    const first = readEventStream(home, 0, { initialize: true });
    expect(first.events.map(e => [e.seq, e.id])).toEqual([[1, 'a']]);
    const old = readFileSync(join(home, 'stream.jsonl'));
    b.append({ id: 'b', goalId: 'GOAL-B', type: 'example', at: '2024-01-01', data: {} });
    const second = readEventStream(home, 1, { generation: first.generation, anchor: first.anchor });
    expect(second.events.map(e => [e.seq, e.id])).toEqual([[2, 'b']]);
    expect(readEventStream(home, 0).events.map(e => [e.seq, e.id])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    writeFileSync(join(home, 'stream.jsonl'), old);
    expect(() => readEventStream(home, 2, { generation: second.generation, anchor: second.anchor })).toThrow(/cursor/);
    unlinkSync(join(home, 'stream.jsonl'));
    expect(() => readEventStream(home, 0)).toThrow(/initialize/);
  });
  it('rejects a corrupt index and a cursor from another generation', () => {
    const home = mkdtempSync(join(tmpdir(), 'apos-stream-'));
    mkdirSync(join(home, 'events'));
    const source = new ChainFile(join(home, 'events', '_project.jsonl'), '_project');
    source.append({ id: 'p1', type: 'probe', at: '2025-01-01', data: {} });
    const first = readEventStream(home, 0, { initialize: true });
    expect(() => readEventStream(home, 1, { generation: 'wrong', anchor: first.anchor })).toThrow(/cursor/);
    const path = join(home, 'stream.jsonl');
    unlinkSync(join(home, 'events', '_project.jsonl'));
    expect(() => readEventStream(home, 0)).toThrow(/source missing or changed/);
    source.append({ id: 'p1', type: 'probe', at: '2025-01-01', data: {} });
    writeFileSync(path, readFileSync(path, 'utf8') + '{');
    expect(() => readEventStream(home, 0)).toThrow(/corrupt/);
  });
  it('reconciles an event durable in the journal before it reached the index', () => {
    const home = mkdtempSync(join(tmpdir(), 'apos-stream-'));
    mkdirSync(join(home, 'events'));
    const source = new ChainFile(join(home, 'events', '_project.jsonl'), '_project');
    const first = readEventStream(home, 0, { initialize: true });
    source.append({ id: 'p1', type: 'probe', at: '2025-01-01', data: {} });
    const resumed = readEventStream(home, 0, { generation: first.generation, anchor: first.anchor });
    expect(resumed.events.map(item => [item.seq, item.id])).toEqual([[1, 'p1']]);
    expect(readEventStream(home, 1, { generation: resumed.generation, anchor: resumed.anchor }).events).toEqual([]);
  });
  it('rejects malformed source event records before assigning a sequence', () => {
    const home = mkdtempSync(join(tmpdir(), 'apos-stream-'));
    mkdirSync(join(home, 'events'));
    new ChainFile(join(home, 'events', '_project.jsonl'), '_project').append({ id: 42, type: 'probe' });
    expect(() => readEventStream(home, 0, { initialize: true })).toThrow();
  });
});
