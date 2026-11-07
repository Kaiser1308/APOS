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
  recovered = new Map<string, Awaited<ReturnType<PackageRuntime['startPackage']>>>();
  async startPackage(input: { package: WorkPackageSpec; repoPath: string }) {
    this.starts.push(input.package.id);
    return { runId: 'run_1', taskId: `task_${input.package.id}`, dispatchId: `ctx_${input.package.id}`, owner: 'worker' as const, repoPath: input.repoPath };
  }
  async recoverPackage(key: string) { return this.recovered.get(key); }
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
    store.append({ id: 'EV-verify', goalId: spec.id, type: 'package-verified', data: { packageId: a.id }, at: '2026-11-07T00:00:00.000Z' });
    expect(service.ready(spec.id).map(item => item.id)).toEqual(['WP-02']);
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
