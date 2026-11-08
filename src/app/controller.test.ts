import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, approval } from '../domain/fixtures.test-support.js';
import { PackageService, type PackageRuntime } from './packages.js';
import { ControllerService } from './controller.js';
import type { RuntimeAdapter } from '../runtime/orca.js';
import type { WorkPackageSpec } from '../domain/packages.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const a: WorkPackageSpec = { id: 'WP-01', goalId: spec.id, goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)@v1'], acceptance: [{ id: 'WP-AC-1', text: 'scan', goalAcceptanceId: 'AC-1' }], integration: 'Lead integrates' };
const b: WorkPackageSpec = { ...a, id: 'WP-02', owner: 'worker-b', outcome: 'History', scope: ['history'], dependencies: ['WP-01'], acceptance: [{ id: 'WP-AC-2', text: 'history works' }] };

it('releases dependency-ready Workers after a restart without duplicate dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-controller-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: import('../domain/transitions.js').GoalEventType, data?: unknown) => store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec); add('goal-approved', approval); add('goal-selected'); add('proposal-drafted', { ...proposal, mode: 'multi-wp' });
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
  const first = (await controller.tick(dir))[0];
  expect(first.dispatched).toEqual(['WP-01']);
  expect(first.settled).toEqual(['WP-01:completed']);
  expect(store.getGoal(spec.id)?.settlements).toEqual({ 'WP-01': 'completed' });
  expect((await controller.tick(dir))[0].dispatched).toEqual([]);
  packages.submitEvidence(spec.id, { packageId: a.id, packageVersion: 1, owner: a.owner, acceptanceId: 'WP-AC-1', result: 'pass', command: 'npm test', artifactRef: 'log:a', commitRef: 'abc' });
  await packages.verify(spec.id, a.id);
  expect((await controller.tick(dir))[0].dispatched).toEqual(['WP-02']);
  expect(starts).toEqual(['WP-01', 'WP-02']);
  store.close();
});

it('records a settled Solo Dispatch once and never accepts it without a delivery commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-controller-solo-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: import('../domain/transitions.js').GoalEventType, data?: unknown) => store.append({ id: `SOLO-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec); add('goal-approved', approval); add('goal-selected'); add('proposal-drafted', proposal); add('proposal-approved');
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startSolo({ repoPath }) { return { runId: 'run-1', taskId: 'task-1', dispatchId: 'ctx-1', owner: 'lead', repoPath }; },
    async resumeSolo() { throw new Error('No resume expected'); },
    async inspect(ref) { return { state: 'settled', outcome: 'completed', ref }; },
    async startPackage() { throw new Error('No package expected'); }
  };
  const controller = new ControllerService(store, runtime);
  expect((await controller.tick(dir))[0].dispatched).toEqual(['ctx-1']);
  expect((await controller.tick(dir))[0].settled).toEqual(['solo:completed']);
  expect((await controller.tick(dir))[0].settled).toEqual([]);
  // With no way to read the owner's delivery commit, the controller parks the Goal for a decision instead of trusting the report.
  expect(store.getGoal(spec.id)).toMatchObject({ status: 'blocked', blocker: { note: expect.stringMatching(/needs-decision: delivery commit unknown/) } });
  store.close();
});

it('processes a settled worker_done, retains its owner, then acknowledges the Orca Delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-controller-inbox-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: import('../domain/transitions.js').GoalEventType, data?: unknown) => store.append({ id: `INBOX-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec); add('goal-approved', approval); add('goal-selected'); add('proposal-drafted', proposal); add('proposal-approved');
  const ref = { runId: 'run-1', taskId: 'task-1', dispatchId: 'ctx-1', owner: 'lead' as const, repoPath: dir };
  add('dispatch-intended', 'key-1'); add('execution-started', ref);
  const actions: string[] = [];
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startSolo() { throw new Error('No new dispatch expected'); }, async resumeSolo() { throw new Error('No resume expected'); },
    async inspect() { return { state: 'settled', outcome: 'completed', ref }; },
    async startPackage() { throw new Error('No package expected'); },
    async checkRun() { actions.push('check'); return { deliveryId: 'delivery-1', messages: [{ id: 'msg-1', type: 'worker_done', payload: { dispatchId: 'ctx-1' } }] }; },
    async retainWorker() { actions.push('retain'); },
    async ackRun() { actions.push('ack'); }
  };
  const tick = (await new ControllerService(store, runtime).tick(dir))[0];
  expect(tick.errors).toEqual([]);
  expect(actions).toEqual(['check', 'retain', 'ack']);
  expect(store.getGoal(spec.id)?.settlements).toEqual({ 'ctx-1': 'completed' });
  store.close();
});
