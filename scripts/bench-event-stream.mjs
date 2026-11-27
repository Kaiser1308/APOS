// Run after `npm run build`; elapsed time excludes constructing the source journal.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readEventStream } from '../dist/store/event-stream.js';

const home = mkdtempSync(join(tmpdir(), 'apos-stream-bench-'));
try {
  mkdirSync(join(home, 'events'));
  let prev = '0'.repeat(64);
  const lines = [];
  for (let i = 0; i < 1500; i++) {
    const event = { id: `e${i}`, type: 'example', at: '2025-01-01' };
    const hash = createHash('sha256').update(prev).update(JSON.stringify(event)).digest('hex');
    lines.push(JSON.stringify({ event, prev, hash }));
    prev = hash;
  }
  writeFileSync(join(home, 'events', '_project.jsonl'), `${lines.join('\n')}\n`);
  const start = performance.now();
  const stream = readEventStream(home, 0, { initialize: true });
  process.stdout.write(`${stream.events.length} events: ${(performance.now() - start).toFixed(1)} ms\n`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
