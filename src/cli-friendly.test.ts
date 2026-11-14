import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { spec, sourceText } from './domain/fixtures.test-support.js';
import type { RuntimeAdapter, RuntimeRef } from './runtime/orca.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

async function project() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-friendly-')); dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-friendly-home-')); dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  const output: string[] = [];
  const ref: RuntimeRef = { runId: 'run_1', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir, terminal: 'term_lead', worktreeId: 'repo::C:/wt', baseCommit: 'c'.repeat(40) };
  const runtime = { async startLead() { return ref; }, async resumeSolo() { return ref; }, async inspect() { return { state: 'live' as const, ref }; } } as RuntimeAdapter;
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { runtime, home, write: line => output.push(line) });
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
  const goal = join(dir, 'goal.json'), source = join(dir, 'brief.md');
  writeFileSync(source, sourceText);
  writeFileSync(goal, JSON.stringify({ ...spec, source: { ...spec.source, sha256: 'f'.repeat(64) } }));
  await expect(invoke('goal', 'create', '--file', goal, '--source', source)).rejects.toThrow(/expected [0-9a-f]{64}.*line endings.*omit "source"/s);
});

it('shows which agent and model the Lead runs on when a Goal is selected (GitHub #4)', async () => {
  const { dir, invoke, output } = await project();
  const goal = join(dir, 'goal.json'), source = join(dir, 'brief.md');
  writeFileSync(source, sourceText);
  writeFileSync(goal, JSON.stringify(spec));
  await invoke('goal', 'create', '--file', goal, '--source', source);
  await invoke('goal', 'approve', spec.id, '--size', 'M', '--max-spend', '20', '--max-minutes', '240', '--max-attempts', '3');
  output.length = 0;
  await invoke('goal', 'select', spec.id);
  const text = output.join('\n');
  expect(text).toMatch(/Lead runs on codex model=gpt-6\.1-terra \(default\)/);
  expect(text.indexOf('Lead runs on')).toBeLessThan(text.indexOf('Dispatched Lead'));
});
