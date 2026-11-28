import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { spec, sourceText } from '../domain/fixtures.test-support.js';
import { ProjectJournal } from '../store/journal.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

it('keeps the original Goal approvable after the CLI rejects a duplicate with a different source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-duplicate-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'apos-duplicate-home-'));
  dirs.push(dir, home);
  execFileSync('git', ['init', '-q', dir]);
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { home, write: () => {}, writeError: () => {} });
  const goal = join(dir, 'goal.json');
  const brief = join(dir, 'brief.md');
  writeFileSync(goal, JSON.stringify(Object.fromEntries(Object.entries(spec).filter(([key]) => key !== 'source'))));
  writeFileSync(brief, sourceText);
  await invoke('init', '--no-agents-md');
  await invoke('goal', 'create', '--file', goal, '--source', brief);
  const snapshot = join(home, 'sources', spec.id, 'v1.md');
  const beforeLog = readFileSync(join(home, 'events', `${spec.id}.jsonl`), 'utf8');
  writeFileSync(brief, 'An unrelated replacement brief.\n');
  await expect(invoke('goal', 'create', '--file', goal, '--source', brief)).rejects.toThrow(/Goal already exists/);
  expect(readFileSync(snapshot, 'utf8')).toBe(sourceText);
  expect(readFileSync(join(home, 'events', `${spec.id}.jsonl`), 'utf8')).toBe(beforeLog);
  await invoke(
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
    'isolated test fixture',
  );
  const opened = ProjectJournal.open(dir, home);
  try {
    expect(opened.journal.getGoal(spec.id)?.status).toBe('approved');
    expect(opened.journal.currentSourceDigest(spec.id)).toBe(spec.source.sha256);
  } finally {
    opened.close();
  }
}, 60_000);
