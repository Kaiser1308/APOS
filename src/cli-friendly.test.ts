import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { spec, sourceText } from './domain/fixtures.test-support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function project() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-friendly-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-friendly-home-'));
  dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  const output: string[] = [];
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { home, write: line => output.push(line) });
  await invoke('init');
  output.length = 0;
  return { dir, invoke, output };
}

it('says so when there are no Goals and nothing waits for the Human (GitHub #9)', async () => {
  const { invoke, output } = await project();
  await invoke('goal', 'list');
  expect(output.join('\n')).toMatch(/No Goals yet/);
  output.length = 0;
  await invoke('inbox');
  expect(output.join('\n')).toMatch(/Inbox is clean/);
});

it('names the expected digest and the CRLF rule when the source sha256 does not match (GitHub #7)', async () => {
  const { dir, invoke } = await project();
  const goal = join(dir, 'goal.json'),
    source = join(dir, 'brief.md');
  writeFileSync(source, sourceText);
  writeFileSync(goal, JSON.stringify({ ...spec, source: { ...spec.source, sha256: 'f'.repeat(64) } }));
  await expect(invoke('goal', 'create', '--file', goal, '--source', source)).rejects.toThrow(
    /expected [0-9a-f]{64}.*line endings.*omit "source"/s,
  );
});
