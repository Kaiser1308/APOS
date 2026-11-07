import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal } from '../domain/fixtures.test-support.js';
import { PackageService, type PackageRuntime } from './packages.js';
import { ControllerService } from './controller.js';
import type { RuntimeAdapter } from '../runtime/orca.js';
import type { WorkPackageSpec } from '../domain/packages.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const a: WorkPackageSpec = { id: 'WP-01', goalId: spec.id, goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)'], acceptance: [{ id: 'WP-AC-1', text: 'scan', goalAcceptanceId: 'AC-1' }], integration: 'Lead integrates' };
const b: WorkPackageSpec = { ...a, id: 'WP-02', owner: 'worker-b', outcome: 'History', scope: ['history'], dependencies: ['WP-01'], acceptance: [{ id: 'WP-AC-2', text: 'history works' }] };

it('releases dependency-ready Workers after a restart without duplicate dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-controller-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: import('../domain/transitions.js').GoalEventType, data?: unknown) => store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec); add('goal-approved'); add('goal-selected'); add('proposal-drafted', { ...proposal, mode: 'multi-wp' });
  const starts: string[] = [];
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startSolo() { throw new Error('Solo not expected'); }, async resumeSolo() { throw new Error('Solo not expected'); },
    async inspect(ref) { return { state: 'settled', ref }; },
    async startPackage({ package: item, repoPath }) { starts.push(item.id); return { runId: 'run-1', taskId: item.id, dispatchId: item.id, owner: 'worker', repoPath }; },
    async inspectPackage() { return 'completed'; }
  };
  const packages = new PackageService(store, runtime);
  packages.add(spec.id, a); packages.add(spec.id, b); add('proposal-approved');
  const controller = new ControllerService(store, runtime);
  expect((await controller.tick(dir))[0].dispatched).toEqual(['WP-01']);
  expect((await controller.tick(dir))[0].dispatched).toEqual([]);
  packages.submitEvidence(spec.id, { packageId: a.id, packageVersion: 1, owner: a.owner, acceptanceId: 'WP-AC-1', result: 'pass', command: 'npm test', artifactRef: 'log:a', commitRef: 'abc' });
  await packages.verify(spec.id, a.id);
  expect((await controller.tick(dir))[0].dispatched).toEqual(['WP-02']);
  expect(starts).toEqual(['WP-01', 'WP-02']);
  store.close();
});
