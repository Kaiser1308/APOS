import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, approval } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import type { RuntimeAdapter } from '../runtime/orca.js';
import type { PackageRuntime } from './packages.js';
import { ControllerService } from './controller.js';
import { LeadService } from './lead.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const a: WorkPackageSpec = {
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
const b: WorkPackageSpec = {
  ...a,
  id: 'WP-02',
  owner: 'worker-b',
  outcome: 'History',
  scope: ['history'],
  acceptance: [{ id: 'WP-AC-2', text: 'history works' }],
};

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-handoff-guard-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  stores.push(store);
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    store.append({ id: `HG-${++n}`, goalId: spec.id, type, data, at: '2026-11-14T00:00:00.000Z' });
  const types = () => store.events(spec.id).map(item => item.type);
  return { dir, store, add, types };
}

describe('a dispatch being handed off (a stopped dispatch reads failed, seen live)', () => {
  it('a Solo owner is never settled, blocked or repaired by a tick while the handoff is open', async () => {
    const { dir, store, add, types } = open();
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const ref = {
      runId: 'run_1',
      taskId: 't',
      dispatchId: 'ctx_1',
      owner: 'lead' as const,
      repoPath: dir,
      terminal: 'term_1',
    };
    add('dispatch-intended', 'k');
    add('execution-started', ref);
    add('handoff-intended', { key: 'h1', target: { kind: 'lead' }, from: 'ctx_1' });
    const runtime: RuntimeAdapter = {
      async startLead() {
        return ref;
      },
      async resumeSolo() {
        throw new Error('no resume during a handoff');
      },
      async inspect(r) {
        return { state: 'settled', outcome: 'failed', ref: r };
      },
    };
    await new ControllerService(store, runtime).tick(dir);
    expect(types()).not.toContain('worker-settled');
    expect(types()).not.toContain('blocked');
    expect(types()).not.toContain('checkpointed');
  });

  it('a package Worker is left unsettled and unblocked', async () => {
    const { dir, store, add, types } = open();
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', { ...proposal, mode: 'multi-wp' });
    add('package-added', a);
    add('package-added', b);
    add('proposal-approved');
    for (const [id, dispatchId] of [
      ['WP-01', 'ctx_wp'],
      ['WP-02', 'ctx_wp2'],
    ]) {
      add('package-dispatch-intended', { packageId: id, key: `k-${id}` });
      add('package-started', {
        packageId: id,
        ref: { runId: 'run-1', taskId: id, dispatchId, owner: 'worker', repoPath: dir },
      });
    }
    add('handoff-intended', { key: 'h1', target: { kind: 'package', packageId: 'WP-01' }, from: 'ctx_wp' });
    const runtime: RuntimeAdapter & PackageRuntime = {
      async startLead() {
        throw new Error('no');
      },
      async resumeSolo() {
        throw new Error('no');
      },
      async inspect(r) {
        return { state: 'live', ref: r };
      },
      async startPackage() {
        throw new Error('no new dispatch');
      },
      async inspectPackage(r) {
        return r.dispatchId === 'ctx_wp' ? 'failed' : 'live';
      },
    };
    await new ControllerService(store, runtime).tick(dir);
    expect(types()).not.toContain('worker-settled');
    expect(types()).not.toContain('package-blocked');
  });

  it('a planning Lead is not recorded as having ended its turn', async () => {
    const { dir, store, add, types } = open();
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('lead-dispatch-intended', 'lk');
    add('lead-started', {
      runId: 'r',
      taskId: 't',
      dispatchId: 'ctx_lead',
      repoPath: dir,
      terminal: 'term_lead',
      worktreeId: 'repo::C:/lead',
      baseCommit: 'a'.repeat(40),
    });
    add('handoff-intended', { key: 'h1', target: { kind: 'lead' }, from: 'ctx_lead' });
    const runtime: RuntimeAdapter = {
      async startLead() {
        throw new Error('no');
      },
      async resumeSolo() {
        throw new Error('no');
      },
      async inspect(r) {
        return { state: 'settled', outcome: 'failed', ref: r };
      },
    };
    await new LeadService(store, runtime).reconcile(spec.id);
    expect(types()).not.toContain('lead-settled');
  });
});
