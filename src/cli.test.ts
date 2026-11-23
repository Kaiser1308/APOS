import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { controllerHome } from './store/event-log.js';
import { spec as baseSpec, sourceText } from './domain/fixtures.test-support.js';

const spec = baseSpec;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

it('refuses approval when the source snapshot was edited after drafting, or a requirement is unmapped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-src-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const output: string[] = [];
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { write: line => output.push(line) });
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
  await invoke('init');
  writeFileSync(join(dir, 'tampered.md'), sourceText + 'Also accept expired codes.\n');
  await expect(
    invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'tampered.md')),
  ).rejects.toThrow(/sha256 does not match/);
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  writeFileSync(join(controllerHome(dir), 'sources', spec.id, 'v1.md'), sourceText + 'Also accept expired codes.\n');
  await expect(
    invoke(
      'goal',
      'approve',
      spec.id,
      '--size',
      'M',
      '--max-minutes',
      '240',
      '--max-attempts',
      '3',
      '--on-behalf',
      'test',
    ),
  ).rejects.toThrow(/Source snapshot .* differs/);

  const orphan = {
    ...spec,
    id: 'GOAL-002',
    requirements: [
      ...spec.requirements,
      { id: 'R-2', sourceSpan: 'line 3', text: 'exactly one', disposition: 'acceptance' },
    ],
  };
  writeFileSync(join(dir, 'goal2.json'), JSON.stringify(orphan));
  await invoke('goal', 'create', '--file', join(dir, 'goal2.json'), '--source', join(dir, 'brief.md'));
  await expect(
    invoke(
      'goal',
      'approve',
      'GOAL-002',
      '--size',
      'M',
      '--max-minutes',
      '240',
      '--max-attempts',
      '3',
      '--on-behalf',
      'test',
    ),
  ).rejects.toThrow(/R-2 has no acceptance/);
}, 30_000);

it('refuses a Human command without a terminal or --on-behalf, and a mistyped id, and writes nothing to the log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-human-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const home = mkdtempSync(join(tmpdir(), 'apos-cli-human-home-'));
  dirs.push(home);
  const approve = ['goal', 'approve', spec.id, '--size', 'M', '--max-minutes', '240'].concat(['--max-attempts', '3']);
  const run = (args: string[], io?: { isTTY: boolean; typed?: string }) =>
    runCli(['--repo', dir, ...args], {
      home,
      write: () => undefined,
      io: io && { isTTY: io.isTTY, prompt: async () => io.typed ?? '' },
    });
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
  await run(['init']);
  await run(['goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md')]);
  const log = () => readFileSync(join(home, 'events', `${spec.id}.jsonl`), 'utf8');
  const before = log();
  await expect(run(approve, { isTTY: false })).rejects.toThrow(/Human decision/);
  await expect(run(approve, { isTTY: true, typed: 'GOAL-WRONG' })).rejects.toThrow(/Human decision/);
  expect(log()).toBe(before);
  await run(approve, { isTTY: true, typed: spec.id });
  const approved = log()
    .trim()
    .split('\n')
    .find(line => line.includes('"goal-approved"'))!;
  expect(JSON.parse(approved).event).toMatchObject({ type: 'goal-approved', data: { confirmation: { by: 'human' } } });
}, 30_000);

it('approves a Goal without --max-spend and says the flag is gone when it is given, writing nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-appetite-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const home = mkdtempSync(join(tmpdir(), 'apos-cli-appetite-home-'));
  dirs.push(home);
  const run = (...args: string[]) => runCli(['--repo', dir, ...args], { home, write: () => undefined });
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
  await run('init');
  await run('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  const log = () => readFileSync(join(home, 'events', `${spec.id}.jsonl`), 'utf8');
  const before = log();
  const flags = ['--size', 'M', '--max-minutes', '240', '--max-attempts', '3', '--on-behalf', 'test'];
  await expect(run('goal', 'approve', spec.id, ...flags, '--max-spend', '20')).rejects.toThrow(
    /--max-spend no longer exists/,
  );
  expect(log()).toBe(before);
  await run('goal', 'approve', spec.id, ...flags);
  expect(log()).toContain('"maxWallMinutes":240');
  expect(log()).not.toMatch(/maxSpend/);
}, 30_000);
