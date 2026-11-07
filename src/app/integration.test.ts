import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal } from '../domain/fixtures.test-support.js';
import { GitCommitInspector, IntegrationService, type CommitInspector } from './integration.js';
import type { WorkPackageSpec } from '../domain/packages.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const first: WorkPackageSpec = { id: 'WP-01', goalId: spec.id, goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)'], acceptance: [{ id: 'WP-AC-1', text: 'scan', goalAcceptanceId: 'AC-1' }], integration: 'Lead integrates' };
const second: WorkPackageSpec = { ...first, id: 'WP-02', owner: 'worker-b', outcome: 'History view', scope: ['history'], acceptance: [{ id: 'WP-AC-2', text: 'view history' }] };
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-integration-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: import('../domain/transitions.js').GoalEventType, data?: unknown) => store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec); add('goal-approved'); add('goal-selected');
  add('proposal-drafted', { ...proposal, mode: 'multi-wp' });
  add('package-added', first); add('package-added', second); add('proposal-approved');
  for (const [item, commitRef] of [[first, 'commit-a'], [second, 'commit-b']] as const) {
    add('package-dispatch-intended', { packageId: item.id, key: `key-${item.id}` });
    add('package-started', { packageId: item.id, ref: { runId: 'run-1', taskId: item.id, dispatchId: item.id, owner: 'worker', repoPath: dir } });
    add('package-evidence-submitted', { packageId: item.id, packageVersion: 1, owner: item.owner, acceptanceId: item.acceptance[0].id, result: 'pass', command: 'npm test', artifactRef: `log:${item.id}`, commitRef });
  }
  return { store, dir, add };
};
const inspector: CommitInspector = {
  exists: (_repo, ref) => ['commit-a', 'commit-b', 'integration'].includes(ref),
  files: (_repo, ref) => ref === 'commit-a' ? ['src/scanner.ts'] : ref === 'commit-b' ? ['src/history.ts'] : ['src/scanner.ts', 'src/history.ts'],
  contains: () => true
};
const evidence = { commitRef: 'integration', acceptance: [{ acceptanceId: 'AC-1', result: 'pass' as const, command: 'npm test', artifactRef: 'log:acceptance' }], regression: { result: 'pass' as const, command: 'npm test', artifactRef: 'log:regression' } };

it('waits for every package before preparing integration', () => {
  const { store, dir, add } = setup();
  add('package-verified', { packageId: first.id });
  expect(() => new IntegrationService(store, inspector).prepare(spec.id, dir)).toThrow(/packages.*verified/i);
  store.close();
});

it('detects overlapping changes and requires an integration resolution', () => {
  const { store, dir, add } = setup();
  add('package-verified', { packageId: first.id }); add('package-verified', { packageId: second.id });
  const overlapping: CommitInspector = { ...inspector, files: (_repo, ref) => ref === 'integration' ? ['src/shared.ts'] : ['src/shared.ts'] };
  const service = new IntegrationService(store, overlapping);
  expect(service.prepare(spec.id, dir).conflicts).toEqual(['src/shared.ts']);
  expect(() => service.complete(spec.id, dir, evidence)).toThrow(/conflict resolution/i);
  service.complete(spec.id, dir, { ...evidence, conflictResolution: 'Lead reconciled shared change and reran tests' });
  expect(store.getGoal(spec.id)?.status).toBe('verified');
  store.close();
});

it('requires passing Goal acceptance and regression on a real integration commit', () => {
  const { store, dir, add } = setup();
  add('package-verified', { packageId: first.id }); add('package-verified', { packageId: second.id });
  const service = new IntegrationService(store, inspector);
  expect(() => service.complete(spec.id, dir, { ...evidence, commitRef: 'missing' })).toThrow(/commit/i);
  expect(() => service.complete(spec.id, dir, { ...evidence, regression: { ...evidence.regression, result: 'fail' } })).toThrow(/regression/i);
  expect(() => new IntegrationService(store, { ...inspector, contains: (_repo, ancestor) => ancestor !== 'commit-b' }).complete(spec.id, dir, evidence)).toThrow(/not integrated/i);
  service.complete(spec.id, dir, evidence);
  expect(store.getGoal(spec.id)?.status).toBe('verified');
  store.close();
});

it('checks commit existence, changed files and ancestry against Git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-commits-')); dirs.push(dir);
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  writeFileSync(join(dir, 'scanner.txt'), 'scanner'); git(['add', 'scanner.txt']);
  git(['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '-qm', 'scanner']);
  const firstCommit = git(['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'history.txt'), 'history'); git(['add', 'history.txt']);
  git(['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '-qm', 'history']);
  const integrated = git(['rev-parse', 'HEAD']);
  const inspector = new GitCommitInspector();
  expect(inspector.exists(dir, firstCommit)).toBe(true);
  expect(inspector.files(dir, firstCommit)).toEqual(['scanner.txt']);
  expect(inspector.contains(dir, firstCommit, integrated)).toBe(true);
  expect(inspector.contains(dir, integrated, firstCommit)).toBe(false);
});
