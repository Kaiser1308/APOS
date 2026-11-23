import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, gateReport as fixtureGate, approval, BASE } from '../domain/fixtures.test-support.js';
import { attemptKey } from '../domain/gate.js';
import { GitCommitInspector, IntegrationService } from './integration.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import { ReviewService } from './review.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const first: WorkPackageSpec = {
  id: 'WP-01',
  goalId: spec.id,
  goalVersion: 1,
  version: 1,
  owner: 'worker-a',
  outcome: 'QR intake',
  scope: ['scanner'],
  exclusions: [],
  dependencies: [],
  interfaces: ['checkIn(token)@v1'],
  acceptance: [{ id: 'WP-AC-1', text: 'scan', goalAcceptanceId: 'AC-1' }],
  integration: 'Lead integrates',
};
const second: WorkPackageSpec = {
  ...first,
  id: 'WP-02',
  owner: 'worker-b',
  outcome: 'History view',
  scope: ['history'],
  acceptance: [{ id: 'WP-AC-2', text: 'view history' }],
};
const setup = (risks: string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-integration-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  add('proposal-drafted', { ...proposal, mode: 'multi-wp', risks });
  add('package-added', first);
  add('package-added', second);
  add('proposal-approved');
  const green = (item: WorkPackageSpec, commit: string) => {
    add('package-submitted', { packageId: item.id, version: 1, commit, base: BASE, by: 'lead' });
    add('package-gate-recorded', {
      packageId: item.id,
      report: fixtureGate(commit, 'green', spec, `${item.id}@1:0`),
    });
  };
  const gateReport = (commit: string, result?: 'green' | 'red') => ({
    ...fixtureGate(commit, result),
    attemptKey: attemptKey(store.getGoal(spec.id)!),
  });
  const greenAll = () => {
    green(first, COMMIT_A);
    green(second, COMMIT_B);
    add('gate-recorded', gateReport(INTEGRATION));
  };
  const review = () =>
    new ReviewService(store).submit(spec.id, {
      subject: 'goal',
      reviewer: 'reviewer-agent',
      session: 'review-1',
      result: 'pass',
      commitRef: INTEGRATION,
      note: 'Checked integrated flow',
    });
  return { store, dir, add, gateReport, review, green, greenAll };
};
const inspector: CommitInspector = {
  exists: (_repo, ref) => [COMMIT_A, COMMIT_B, INTEGRATION].includes(ref),
  files: (_repo, ref) =>
    ref === COMMIT_A
      ? ['src/scanner.ts']
      : ref === COMMIT_B
        ? ['src/history.ts']
        : ['src/scanner.ts', 'src/history.ts'],
  contains: () => true,
};
const INTEGRATION = 'c'.repeat(40);
const COMMIT_A = '1'.repeat(40);
const COMMIT_B = '2'.repeat(40);
const evidence = {
  commitRef: INTEGRATION,
  acceptance: [{ acceptanceId: 'AC-1', result: 'pass' as const, command: 'npm test', artifactRef: 'log:acceptance' }],
  regression: { result: 'pass' as const, command: 'npm test', artifactRef: 'log:regression' },
};

it('completes with only the commit and controller evidence', () => {
  const { store, dir, greenAll } = setup();
  greenAll();
  new IntegrationService(store, inspector).complete(spec.id, dir, { commitRef: INTEGRATION });
  expect(store.getGoal(spec.id)?.status).toBe('verified');
  store.close();
});

it('waits for every package before preparing integration', () => {
  const { store, dir, green } = setup();
  green(first, COMMIT_A);
  expect(() => new IntegrationService(store, inspector).prepare(spec.id, dir)).toThrow(/packages.*green/i);
  store.close();
});

it('detects overlapping changes and requires an integration resolution', () => {
  const { store, dir, greenAll } = setup();
  greenAll();
  const overlapping: CommitInspector = {
    ...inspector,
    files: (_repo, ref) => (ref === 'integration' ? ['src/shared.ts'] : ['src/shared.ts']),
  };
  const service = new IntegrationService(store, overlapping);
  expect(service.prepare(spec.id, dir).conflicts).toEqual(['src/shared.ts']);
  expect(() => service.complete(spec.id, dir, evidence)).toThrow(/conflict resolution/i);
  service.complete(spec.id, dir, { ...evidence, conflictResolution: 'Lead reconciled shared change and reran tests' });
  expect(store.getGoal(spec.id)?.status).toBe('verified');
  store.close();
});

it('requires passing Goal acceptance and regression on a real integration commit', () => {
  const { store, dir, greenAll } = setup();
  greenAll();
  const service = new IntegrationService(store, inspector);
  expect(() => service.complete(spec.id, dir, { ...evidence, commitRef: 'missing' })).toThrow(/commit/i);
  expect(() =>
    new IntegrationService(store, { ...inspector, contains: (_repo, ancestor) => ancestor !== COMMIT_B }).complete(
      spec.id,
      dir,
      evidence,
    ),
  ).toThrow(/not integrated/i);
  service.complete(spec.id, dir, evidence);
  expect(store.getGoal(spec.id)?.status).toBe('verified');
  store.close();
});

it('refuses integration when the controller gate on the integration commit is not green', () => {
  const { store, dir, green, add, gateReport } = setup();
  green(first, COMMIT_A);
  green(second, COMMIT_B);
  add('gate-recorded', gateReport(INTEGRATION, 'red'));
  expect(() => new IntegrationService(store, inspector).complete(spec.id, dir, evidence)).toThrow(
    /green controller gate/i,
  );
  expect(store.getGoal(spec.id)?.integration).toBeUndefined();
  store.close();
});

it('checks commit existence, changed files and ancestry against Git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-commits-'));
  dirs.push(dir);
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  writeFileSync(join(dir, 'scanner.txt'), 'scanner');
  git(['add', 'scanner.txt']);
  git(['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '-qm', 'scanner']);
  const firstCommit = git(['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'history.txt'), 'history');
  git(['add', 'history.txt']);
  git(['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '-qm', 'history']);
  const integrated = git(['rev-parse', 'HEAD']);
  const inspector = new GitCommitInspector();
  expect(inspector.exists(dir, firstCommit)).toBe(true);
  expect(inspector.exists(dir, '--help')).toBe(false);
  expect(inspector.files(dir, firstCommit)).toEqual(['scanner.txt']);
  expect(inspector.files(dir, integrated, firstCommit)).toEqual(['history.txt']);
  expect(inspector.contains(dir, firstCommit, integrated)).toBe(true);
  expect(inspector.contains(dir, integrated, firstCommit)).toBe(false);
});

it('no longer needs a review to integrate: the gate is the condition, a review is advice', () => {
  const { store, dir, greenAll, review } = setup(['Auth regression']);
  greenAll();
  const service = new IntegrationService(store, inspector);
  service.complete(spec.id, dir, evidence);
  expect(store.getGoal(spec.id)).toMatchObject({ status: 'verified', integration: { commitRef: INTEGRATION } });
  review();
  expect(store.getGoal(spec.id)?.reviews).toHaveLength(1);
  store.close();
});
