#!/usr/bin/env node
// Usage: node scripts/capture-replay-fixtures.mjs <apos-home> <case-name> [event-type-regex]
// Copies the event logs under <apos-home>/projects/*/events/*.jsonl into
// src/store/fixtures/replay/<case-name>/events/, replacing machine-specific text in every string value
// and recomputing the hash chain. With a regex, only Goals that have at least one matching event type are kept.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [homeArg, caseName, typeFilter] = process.argv.slice(2);
if (!homeArg || !caseName) {
  console.error('usage: capture-replay-fixtures.mjs <apos-home> <case-name> [event-type-regex]');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'store', 'fixtures', 'replay', caseName, 'events');
const GENESIS = '0'.repeat(64);
const chain = (prev, event) => createHash('sha256').update(prev).update(JSON.stringify(event)).digest('hex');

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bothSlashes = path => {
  const forward = path.replace(/\\/g, '/');
  return [forward, forward.replace(/\//g, '\\')];
};
// Longest prefixes first so the specific ones win over the generic drive-letter rule.
const prefixes = [
  ...bothSlashes(resolve(homeArg)),
  ...bothSlashes(tmpdir()),
  ...bothSlashes(root),
  ...bothSlashes(homedir()),
].sort((a, b) => b.length - a.length);
const rules = [
  ...prefixes.map(prefix => [new RegExp(escapeRe(prefix), 'gi'), '/fixture']),
  [/[A-Za-z]:[\\/]/g, '/fixture/'],
  [/\/fixture[^\s"']*/g, match => match.replace(/\\/g, '/')],
  [new RegExp(escapeRe(userInfo().username), 'gi'), 'user'],
];
const scrubText = text => rules.reduce((acc, [pattern, to]) => acc.replace(pattern, to), text);
const scrub = value => {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return value;
};

const projects = join(resolve(homeArg), 'projects');
let written = 0;
for (const project of existsSync(projects) ? readdirSync(projects) : []) {
  const dir = join(projects, project, 'events');
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).filter(file => /^GOAL-[A-Z0-9-]+\.jsonl$/.test(file))) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n').slice(0, -1);
    const events = lines.map(line => JSON.parse(line).event);
    if (typeFilter && !events.some(event => new RegExp(typeFilter).test(event.type))) continue;
    let prev = GENESIS;
    const rewritten = events.map(event => {
      const clean = scrub(event);
      const hash = chain(prev, clean);
      const line = JSON.stringify({ event: clean, prev, hash });
      prev = hash;
      return line;
    });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, name), `${rewritten.join('\n')}\n`);
    written += 1;
    console.log(`${caseName}/${name}: ${events.length} events`);
  }
}
if (written === 0) {
  console.error('no matching event logs found');
  process.exit(1);
}
