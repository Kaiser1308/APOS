import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, approval } from '../domain/fixtures.test-support.js';
import { PackageService } from './package-service.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import { ReviewService } from './review.js';
import type { PackageRuntime } from '../ports/runtime.js';

const a: WorkPackageSpec = {
  id: 'WP-01',
  goalId: 'GOAL-001',
  goalVersion: 1,
  version: 1,
  owner: 'worker-a',
  outcome: 'QR scanner works',
  scope: ['scanner'],
  exclusions: [],
  dependencies: [],
  interfaces: ['checkIn(token) -> result@v1'],
  acceptance: [{ id: 'WP-AC-1', text: 'scans valid QR', goalAcceptanceId: 'AC-1' }],
  integration: 'Lead verifies check-in',
};
const b: WorkPackageSpec = {
  ...a,
  id: 'WP-02',
  owner: 'worker-b',
  outcome: 'History works',
  acceptance: [{ id: 'WP-AC-2', text: 'persists history' }],
  dependencies: ['WP-01'],
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = (risks: string[] = [], maxAttempts = 3) => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-packages-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  for (const [type, data] of [
    ['goal-drafted', spec],
    ['goal-approved', { appetite: { ...approval.appetite, maxAttempts } }],
    ['goal-selected', undefined],
    ['proposal-drafted', { ...proposal, mode: 'multi-wp', risks }],
  ] as const)
    store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  return { store, dir };
};
const approve = (store: SqliteStore) =>
  store.append({
    id: `EV-approve-${Math.random()}`,
    goalId: spec.id,
    type: 'proposal-approved',
    at: '2026-11-07T00:00:00.000Z',
  });
class FakeRuntime implements PackageRuntime {
  starts: string[] = [];
  resumes: string[] = [];
  inspectState: 'completed' | 'failed' | 'live' | 'unverifiable' = 'completed';
  recovered = new Map<string, Awaited<ReturnType<PackageRuntime['startPackage']>>>();
  deps = new Map<string, string[] | undefined>();
  async startPackage(input: { package: WorkPackageSpec; repoPath: string; dependencyCommits?: string[] }) {
    this.starts.push(input.package.id);
    this.deps.set(input.package.id, input.dependencyCommits);
    return {
      runId: 'run_1',
      taskId: `task_${input.package.id}`,
      dispatchId: `ctx_${input.package.id}`,
      owner: 'worker' as const,
      repoPath: input.repoPath,
    };
  }
  async recoverPackage(key: string) {
    return this.recovered.get(key);
  }
  async inspectPackage() {
    return this.inspectState;
  }
  async resumePackage(input: { package: WorkPackageSpec; prior: Awaited<ReturnType<PackageRuntime['startPackage']>> }) {
    this.resumes.push(input.package.id);
    return { ...input.prior, dispatchId: `ctx-resumed-${input.package.id}` };
  }
}

describe('package scheduling', () => {
  it('lets Lead draft packages before approval but refuses dispatch', async () => {
    const { store } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, b);
    await expect(service.dispatchReady(spec.id, 'C:/project')).rejects.toThrow(/Approved Multi-WP Goal required/);
    store.close();
  });
  it('dispatches only the dependency-ready package and does not duplicate it', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    expect(service.ready(spec.id).map(item => item.id)).toEqual(['WP-01']);
    await service.dispatchReady(spec.id, dir);
    await service.dispatchReady(spec.id, dir);
    expect(runtime.starts).toEqual(['WP-01']);
    expect(service.ready(spec.id)).toEqual([]);
    store.close();
  });
  it('dispatches independent packages in one wave', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    expect(service.ready(spec.id).map(item => item.id)).toEqual(['WP-01', 'WP-02']);
    await service.dispatchReady(spec.id, dir);
    expect(runtime.starts).toEqual(['WP-01', 'WP-02']);
    store.close();
  });
  it('keeps dependents blocked until the prerequisite is verified', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    expect(service.ready(spec.id)).toEqual([]);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:test',
      commitRef: 'abc123',
    });
    await service.verify(spec.id, a.id);
    expect(service.ready(spec.id).map(item => item.id)).toEqual(['WP-02']);
    store.close();
  });
  it('starts a dependent package from its verified dependency commits (seen live: it started without them)', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:test',
      commitRef: 'abc123',
    });
    await service.verify(spec.id, a.id);
    await service.dispatchReady(spec.id, dir);
    expect(runtime.deps.get('WP-01')).toEqual([]);
    expect(runtime.deps.get('WP-02')).toEqual(['abc123']);
    store.close();
  });
  it('requires current-owner passing evidence for every local criterion', async () => {
    const { store, dir } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    await service.dispatchReady(spec.id, dir);
    const evidence = {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass' as const,
      command: 'npm test',
      artifactRef: 'log:test',
      commitRef: 'abc123',
    };
    expect(() => service.submitEvidence(spec.id, { ...evidence, owner: 'wrong-owner' })).toThrow(/owner/i);
    expect(() => service.submitEvidence(spec.id, { ...evidence, packageVersion: 2 })).toThrow(/version/i);
    await expect(service.verify(spec.id, a.id)).rejects.toThrow(/evidence/i);
    service.submitEvidence(spec.id, { ...evidence, result: 'fail' });
    await expect(service.verify(spec.id, a.id)).rejects.toThrow(/evidence/i);
    service.submitEvidence(spec.id, evidence);
    await service.verify(spec.id, a.id);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('verified');
    store.close();
  });
  it('does not verify a package while its Orca Worker is still live', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    runtime.inspectState = 'live';
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:a',
      commitRef: 'abc123',
    });
    await expect(service.verify(spec.id, a.id)).rejects.toThrow(/Orca Worker must complete/);
    expect(service.ready(spec.id)).toEqual([]);
    store.close();
  });
  it('requires a different reviewer for a risky package before releasing dependents', async () => {
    const { store, dir } = fixture(['Auth regression']);
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:a',
      commitRef: 'commit-a',
    });
    await expect(service.verify(spec.id, a.id)).rejects.toThrow(/independent package review/i);
    const reviews = new ReviewService(store);
    expect(() =>
      reviews.submit(spec.id, {
        subject: 'package',
        packageId: a.id,
        packageVersion: 1,
        reviewer: a.owner,
        session: 'self',
        result: 'pass',
        commitRef: 'commit-a',
        note: 'Self review',
      }),
    ).toThrow(/Reviewer must differ/);
    reviews.submit(spec.id, {
      subject: 'package',
      packageId: a.id,
      packageVersion: 1,
      reviewer: 'reviewer-agent',
      session: 'review-reviewer-agent',
      result: 'pass',
      commitRef: 'commit-a',
      note: 'Checked diff and tests',
    });
    await service.verify(spec.id, a.id);
    expect(service.ready(spec.id).map(item => item.id)).toEqual([b.id]);
    store.close();
  });
  it('parks a package when its approved attempt budget is exhausted', async () => {
    const { store, dir } = fixture([], 1);
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'fail',
      command: 'npm test',
      artifactRef: 'log:a',
      commitRef: 'commit-a',
    });
    new ReviewService(store).submit(spec.id, {
      subject: 'package',
      packageId: a.id,
      packageVersion: 1,
      reviewer: 'reviewer-agent',
      session: 'review-reviewer-agent',
      result: 'changes',
      commitRef: 'commit-a',
      note: 'Fix validation',
    });
    await expect(service.resumeStale(spec.id, a.id)).rejects.toThrow(/budget exhausted/);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('blocked');
    expect(runtime.resumes).toEqual([]);
    store.close();
  });
  it('invalidates verified downstream evidence when an upstream contract changes', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:a',
      commitRef: 'abc123',
    });
    await service.verify(spec.id, a.id);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: b.id,
      packageVersion: 1,
      owner: b.owner,
      acceptanceId: 'WP-AC-2',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:b',
      commitRef: 'def456',
    });
    await service.verify(spec.id, b.id);
    service.revise(
      spec.id,
      { ...a, version: 2, interfaces: ['checkIn(token, device) -> result@v1'] },
      'Contract now includes device',
    );
    const packages = store.getGoal(spec.id)?.packages;
    expect(packages?.[a.id]?.status).toBe('stale');
    expect(packages?.[b.id]?.status).toBe('stale');
    expect(packages?.[a.id]?.evidence).toEqual([]);
    expect(packages?.[b.id]?.evidence).toEqual([]);
    await expect(service.verify(spec.id, b.id)).rejects.toThrow();
    await service.resumeStale(spec.id, a.id);
    expect(runtime.resumes).toEqual(['WP-01']);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('executing');
    await expect(service.resumeStale(spec.id, b.id)).rejects.toThrow(/dependencies/i);
    store.close();
  });
  it('rejects a package revision that changes the approved product scope or owner', () => {
    const { store } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    expect(() => service.revise(spec.id, { ...a, version: 2, scope: ['new product area'] }, 'Expand scope')).toThrow(
      /Goal reapproval/i,
    );
    expect(() => service.revise(spec.id, { ...a, version: 2, owner: 'another-worker' }, 'Change owner')).toThrow(
      /owner/i,
    );
    store.close();
  });
  it('parks an external blocker and resumes the same owner after a recorded resolution', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.recordBlocker(spec.id, a.id, 'external', 'Device service unavailable');
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('blocked');
    service.unblock(spec.id, a.id, 'Device service restored');
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('stale');
    await service.resumeStale(spec.id, a.id);
    expect(runtime.resumes).toEqual(['WP-01']);
    store.close();
  });
  it('keeps a product blocker parked for Goal reapproval', async () => {
    const { store, dir } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.recordBlocker(spec.id, a.id, 'product', 'New flow required');
    expect(() => service.unblock(spec.id, a.id, 'Proceed')).toThrow(/Goal reapproval/i);
    store.close();
  });
  it('recovers a lost resume response without creating another dispatch', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.recordBlocker(spec.id, a.id, 'external', 'Offline');
    service.unblock(spec.id, a.id, 'Online');
    store.append({
      id: 'EV-resume-intent',
      goalId: spec.id,
      type: 'package-resume-intended',
      data: { packageId: a.id, key: 'resume-lost' },
      at: '2026-11-07T00:00:00.000Z',
    });
    runtime.recovered.set('resume-lost', {
      runId: 'run_1',
      taskId: 'task_2',
      dispatchId: 'ctx_2',
      owner: 'worker',
      repoPath: dir,
    });
    expect(await service.reconcile(spec.id)).toEqual([{ packageId: a.id, state: 'recovered' }]);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.runtimeRef).toMatchObject({ dispatchId: 'ctx_2' });
    expect(runtime.resumes).toEqual([]);
    store.close();
  });
  it('recovers an unknown dispatch instead of starting a second worker', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    store.append({
      id: 'EV-intent',
      goalId: spec.id,
      type: 'package-dispatch-intended',
      data: { packageId: a.id, key: 'key-lost' },
      at: '2026-11-07T00:00:00.000Z',
    });
    runtime.recovered.set('key-lost', {
      runId: 'run-recovered',
      taskId: 'task-recovered',
      dispatchId: 'ctx-recovered',
      owner: 'worker',
      repoPath: dir,
    });
    await service.reconcile(spec.id);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.runtimeRef).toMatchObject({ dispatchId: 'ctx-recovered' });
    await service.dispatchReady(spec.id, dir);
    expect(runtime.starts).toEqual(['WP-02']);
    store.close();
  });
});
