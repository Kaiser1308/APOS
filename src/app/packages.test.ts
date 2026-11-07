import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal } from '../domain/fixtures.test-support.js';
import { PackageService, type PackageRuntime } from './packages.js';
import type { WorkPackageSpec } from '../domain/packages.js';

const a: WorkPackageSpec = {
  id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 1, owner: 'worker-a',
  outcome: 'QR scanner works', scope: ['scanner'], exclusions: [], dependencies: [],
  interfaces: ['checkIn(token) -> result'], acceptance: [{ id: 'WP-AC-1', text: 'scans valid QR', goalAcceptanceId: 'AC-1' }],
  integration: 'Lead verifies check-in'
};
const b: WorkPackageSpec = {
  ...a, id: 'WP-02', owner: 'worker-b', outcome: 'History works',
  acceptance: [{ id: 'WP-AC-2', text: 'persists history' }], dependencies: ['WP-01']
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-packages-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  for (const [type, data] of [
    ['goal-drafted', spec], ['goal-approved', undefined], ['goal-selected', undefined],
    ['proposal-drafted', { ...proposal, mode: 'multi-wp' }], ['proposal-approved', undefined]
  ] as const) store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  return { store, dir };
};
class FakeRuntime implements PackageRuntime {
  starts: string[] = [];
  resumes: string[] = [];
  recovered = new Map<string, Awaited<ReturnType<PackageRuntime['startPackage']>>>();
  async startPackage(input: { package: WorkPackageSpec; repoPath: string }) {
    this.starts.push(input.package.id);
    return { runId: 'run_1', taskId: `task_${input.package.id}`, dispatchId: `ctx_${input.package.id}`, owner: 'worker' as const, repoPath: input.repoPath };
  }
  async recoverPackage(key: string) { return this.recovered.get(key); }
  async inspectPackage() { return 'settled' as const; }
  async resumePackage(input: { package: WorkPackageSpec; prior: Awaited<ReturnType<PackageRuntime['startPackage']>> }) {
    this.resumes.push(input.package.id);
    return { ...input.prior, dispatchId: `ctx-resumed-${input.package.id}` };
  }
}

describe('package scheduling', () => {
  it('rejects package creation before Human approval of the proposal', () => {
    const { store } = fixture();
    store.append({ id: 'EV-revise', goalId: spec.id, type: 'proposal-revised', data: { ...proposal, mode: 'multi-wp', version: 2 }, at: '2026-11-07T00:00:00.000Z' });
    const service = new PackageService(store, new FakeRuntime());
    expect(() => service.add(spec.id, a)).toThrow(/Approved Multi-WP proposal required/);
    store.close();
  });
  it('dispatches only the dependency-ready package and does not duplicate it', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a); service.add(spec.id, b);
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
    service.add(spec.id, a); service.add(spec.id, { ...b, dependencies: [] });
    expect(service.ready(spec.id).map(item => item.id)).toEqual(['WP-01', 'WP-02']);
    await service.dispatchReady(spec.id, dir);
    expect(runtime.starts).toEqual(['WP-01', 'WP-02']);
    store.close();
  });
  it('keeps dependents blocked until the prerequisite is verified', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a); service.add(spec.id, b);
    await service.dispatchReady(spec.id, dir);
    expect(service.ready(spec.id)).toEqual([]);
    service.submitEvidence(spec.id, { packageId: a.id, packageVersion: 1, owner: a.owner, acceptanceId: 'WP-AC-1', result: 'pass', command: 'npm test', artifactRef: 'log:test', commitRef: 'abc123' });
    service.verify(spec.id, a.id);
    expect(service.ready(spec.id).map(item => item.id)).toEqual(['WP-02']);
    store.close();
  });
  it('requires current-owner passing evidence for every local criterion', async () => {
    const { store, dir } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a); service.add(spec.id, { ...b, dependencies: [] });
    await service.dispatchReady(spec.id, dir);
    const evidence = { packageId: a.id, packageVersion: 1, owner: a.owner, acceptanceId: 'WP-AC-1', result: 'pass' as const, command: 'npm test', artifactRef: 'log:test', commitRef: 'abc123' };
    expect(() => service.submitEvidence(spec.id, { ...evidence, owner: 'wrong-owner' })).toThrow(/owner/i);
    expect(() => service.submitEvidence(spec.id, { ...evidence, packageVersion: 2 })).toThrow(/version/i);
    expect(() => service.verify(spec.id, a.id)).toThrow(/evidence/i);
    service.submitEvidence(spec.id, { ...evidence, result: 'fail' });
    expect(() => service.verify(spec.id, a.id)).toThrow(/evidence/i);
    service.submitEvidence(spec.id, evidence);
    service.verify(spec.id, a.id);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('verified');
    store.close();
  });
  it('invalidates verified downstream evidence when an upstream contract changes', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a); service.add(spec.id, b);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, { packageId: a.id, packageVersion: 1, owner: a.owner, acceptanceId: 'WP-AC-1', result: 'pass', command: 'npm test', artifactRef: 'log:a', commitRef: 'abc123' });
    service.verify(spec.id, a.id);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, { packageId: b.id, packageVersion: 1, owner: b.owner, acceptanceId: 'WP-AC-2', result: 'pass', command: 'npm test', artifactRef: 'log:b', commitRef: 'def456' });
    service.verify(spec.id, b.id);
    service.revise(spec.id, { ...a, version: 2, interfaces: ['checkIn(token, device) -> result'] }, 'Contract now includes device');
    const packages = store.getGoal(spec.id)?.packages;
    expect(packages?.[a.id]?.status).toBe('stale');
    expect(packages?.[b.id]?.status).toBe('stale');
    expect(packages?.[a.id]?.evidence).toEqual([]);
    expect(packages?.[b.id]?.evidence).toEqual([]);
    expect(() => service.verify(spec.id, b.id)).toThrow();
    await service.resumeStale(spec.id, a.id);
    expect(runtime.resumes).toEqual(['WP-01']);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('executing');
    await expect(service.resumeStale(spec.id, b.id)).rejects.toThrow(/dependencies/i);
    store.close();
  });
  it('rejects a package revision that changes the approved product scope or owner', () => {
    const { store } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a); service.add(spec.id, b);
    expect(() => service.revise(spec.id, { ...a, version: 2, scope: ['new product area'] }, 'Expand scope')).toThrow(/Goal reapproval/i);
    expect(() => service.revise(spec.id, { ...a, version: 2, owner: 'another-worker' }, 'Change owner')).toThrow(/owner/i);
    store.close();
  });
  it('parks an external blocker and resumes the same owner after a recorded resolution', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a); service.add(spec.id, { ...b, dependencies: [] });
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
    service.add(spec.id, a); service.add(spec.id, { ...b, dependencies: [] });
    await service.dispatchReady(spec.id, dir);
    service.recordBlocker(spec.id, a.id, 'product', 'New flow required');
    expect(() => service.unblock(spec.id, a.id, 'Proceed')).toThrow(/Goal reapproval/i);
    store.close();
  });
  it('recovers a lost resume response without creating another dispatch', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a); service.add(spec.id, { ...b, dependencies: [] });
    await service.dispatchReady(spec.id, dir);
    service.recordBlocker(spec.id, a.id, 'external', 'Offline');
    service.unblock(spec.id, a.id, 'Online');
    store.append({ id: 'EV-resume-intent', goalId: spec.id, type: 'package-resume-intended', data: { packageId: a.id, key: 'resume-lost' }, at: '2026-11-07T00:00:00.000Z' });
    runtime.recovered.set('resume-lost', { runId: 'run_1', taskId: 'task_2', dispatchId: 'ctx_2', owner: 'worker', repoPath: dir });
    expect(await service.reconcile(spec.id)).toEqual([{ packageId: a.id, state: 'recovered' }]);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.runtimeRef).toMatchObject({ dispatchId: 'ctx_2' });
    expect(runtime.resumes).toEqual([]);
    store.close();
  });
  it('recovers an unknown dispatch instead of starting a second worker', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a); service.add(spec.id, { ...b, dependencies: [] });
    store.append({ id: 'EV-intent', goalId: spec.id, type: 'package-dispatch-intended', data: { packageId: a.id, key: 'key-lost' }, at: '2026-11-07T00:00:00.000Z' });
    runtime.recovered.set('key-lost', { runId: 'run-recovered', taskId: 'task-recovered', dispatchId: 'ctx-recovered', owner: 'worker', repoPath: dir });
    await service.reconcile(spec.id);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.runtimeRef).toMatchObject({ dispatchId: 'ctx-recovered' });
    await service.dispatchReady(spec.id, dir);
    expect(runtime.starts).toEqual(['WP-02']);
    store.close();
  });
});
