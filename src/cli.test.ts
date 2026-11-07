import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { spec, proposal } from './domain/fixtures.test-support.js';
import type { RuntimeAdapter, RuntimeRef } from './runtime/orca.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

it('requires separate Goal approval, selection and Proposal approval before auto dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-')); dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const goalFile = join(dir, 'goal-input.json');
  const proposalFile = join(dir, 'proposal-input.json');
  writeFileSync(goalFile, JSON.stringify(spec));
  writeFileSync(proposalFile, JSON.stringify(proposal));
  let starts = 0;
  const ref: RuntimeRef = { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir };
  const runtime: RuntimeAdapter = {
    async startSolo() { starts++; return ref; },
    async resumeSolo() { return ref; },
    async inspect() { return { state: 'live', ref }; }
  };
  const output: string[] = [];
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { runtime, write: line => output.push(line) });
  await invoke('init');
  await invoke('goal', 'create', '--file', goalFile);
  await invoke('goal', 'approve', spec.id);
  await invoke('lead', 'recommend');
  expect(starts).toBe(0);
  expect(output.join('\n')).toContain(spec.id);
  await invoke('goal', 'select', spec.id);
  await invoke('lead', 'propose', '--file', proposalFile);
  expect(starts).toBe(0);
  await invoke('execution', 'approve', spec.id);
  expect(starts).toBe(1);
  await invoke('execution', 'status', spec.id);
  expect(output.at(-1)).toContain('executing');
  await invoke('execution', 'reconcile', spec.id);
  expect(output.at(-1)).toContain('live');
  await invoke('decision', 'record', spec.id, '--note', 'Use existing auth flow');
  await invoke('blocker', 'report', spec.id, '--kind', 'external', '--note', 'Test service unavailable');
  await invoke('blocker', 'resolve', spec.id, '--note', 'Test service restored');
  const evidenceFile = join(dir, 'evidence-input.json');
  writeFileSync(evidenceFile, JSON.stringify({ acceptanceId: 'AC-1', result: 'pass', command: 'npm test', artifactRef: 'commit:abc' }));
  await invoke('evidence', 'add', spec.id, '--file', evidenceFile);
  await invoke('execution', 'verify', spec.id);
  await invoke('outcome', 'close', spec.id);
  await invoke('execution', 'status', spec.id);
  expect(output.at(-1)).toContain('closed');
});
