import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { spec, proposal } from './domain/fixtures.test-support.js';
import type { RuntimeAdapter, RuntimeRef } from './runtime/orca.js';
import type { WorkPackageSpec } from './domain/packages.js';
import type { PackageRuntime } from './app/packages.js';

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
  let soloDone = false;
  const released: string[] = [];
  const ref: RuntimeRef = { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir };
  const runtime: RuntimeAdapter = {
    async startSolo() { starts++; return ref; },
    async resumeSolo() { return ref; },
    async inspect() { return soloDone ? { state: 'settled', outcome: 'completed', ref } : { state: 'live', ref }; },
    async releaseWorker(dispatchId) { released.push(dispatchId); }
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
  soloDone = true;
  await invoke('controller', 'tick');
  await invoke('execution', 'verify', spec.id);
  await invoke('outcome', 'close', spec.id);
  expect(released).toEqual(['ctx_1']);
  await invoke('execution', 'status', spec.id);
  expect(output.at(-1)).toContain('closed');
}, 30_000);

it('runs an approved two-package Goal through dependency release, integration and Human closure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-multi-')); dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const input = (name: string, data: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(data)); return path; };
  const a: WorkPackageSpec = { id: 'WP-01', goalId: spec.id, goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)'], acceptance: [{ id: 'WP-AC-1', text: 'scan', goalAcceptanceId: 'AC-1' }], integration: 'Lead integrates' };
  const b: WorkPackageSpec = { ...a, id: 'WP-02', owner: 'worker-b', outcome: 'History', scope: ['history'], dependencies: ['WP-01'], acceptance: [{ id: 'WP-AC-2', text: 'history works' }] };
  const starts: string[] = [];
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startSolo() { throw new Error('Solo must not start'); },
    async resumeSolo() { throw new Error('Solo must not resume'); },
    async inspect(ref) { return { state: 'settled', ref }; },
    async inspectPackage() { return 'completed'; },
    async startPackage({ package: item, repoPath }) { starts.push(item.id); return { runId: 'run_1', taskId: item.id, dispatchId: item.id, owner: 'worker', repoPath }; }
  };
  const output: string[] = [];
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { runtime, write: line => output.push(line) });
  await invoke('init');
  await invoke('goal', 'create', '--file', input('goal.json', spec));
  await invoke('goal', 'approve', spec.id); await invoke('goal', 'select', spec.id);
  await invoke('lead', 'propose', '--file', input('proposal.json', { ...proposal, mode: 'multi-wp' }));
  await invoke('package', 'add', '--file', input('wp-a.json', a));
  await invoke('package', 'add', '--file', input('wp-b.json', b));
  expect(starts).toEqual([]);
  await invoke('execution', 'approve', spec.id);
  expect(starts).toEqual(['WP-01']);
  writeFileSync(join(dir, 'scanner.ts'), 'export const scan = true;'); git(['add', 'scanner.ts']);
  git(['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '-qm', 'scanner']);
  const commitA = git(['rev-parse', 'HEAD']);
  await invoke('package', 'evidence', spec.id, '--file', input('evidence-a.json', { packageId: a.id, packageVersion: 1, owner: a.owner, acceptanceId: 'WP-AC-1', result: 'pass', command: 'npm test', artifactRef: 'log:a', commitRef: commitA }));
  await invoke('package', 'verify', spec.id, a.id);
  await invoke('package', 'ready', spec.id);
  expect(output.at(-1)).toBe('[]');
  expect(starts).toEqual(['WP-01', 'WP-02']);
  writeFileSync(join(dir, 'history.ts'), 'export const history = true;'); git(['add', 'history.ts']);
  git(['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '-qm', 'history']);
  const commitB = git(['rev-parse', 'HEAD']);
  await invoke('package', 'evidence', spec.id, '--file', input('evidence-b.json', { packageId: b.id, packageVersion: 1, owner: b.owner, acceptanceId: 'WP-AC-2', result: 'pass', command: 'npm test', artifactRef: 'log:b', commitRef: commitB }));
  await invoke('package', 'verify', spec.id, b.id);
  await invoke('integration', 'prepare', spec.id);
  expect(output.at(-1)).toContain(commitA);
  const integrationCommit = git(['rev-parse', 'HEAD']);
  await invoke('integration', 'complete', spec.id, '--file', input('integration.json', { commitRef: integrationCommit, acceptance: [{ acceptanceId: 'AC-1', result: 'pass', command: 'npm test', artifactRef: 'log:goal' }], regression: { result: 'pass', command: 'npm test', artifactRef: 'log:regression' } }));
  await invoke('outcome', 'close', spec.id);
  await invoke('execution', 'status', spec.id);
  expect(output.at(-1)).toContain('closed');
}, 30_000);
