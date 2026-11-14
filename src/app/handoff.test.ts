import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, approval } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import type { HandoffInput, RuntimeAdapter, RuntimeRef } from '../runtime/orca.js';
import { DEFAULT_PROFILES, type RuntimeProfiles } from '../runtime/brief.js';
import type { PackageRuntime } from './packages.js';
import { HandoffService } from './handoff.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
const BASE = 'b'.repeat(40);
const pkg: WorkPackageSpec = { id: 'WP-01', goalId: spec.id, goalVersion: 1, version: 2, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)@v1'], acceptance: [{ id: 'WP-AC-1', text: 'scan', goalAcceptanceId: 'AC-1' }], integration: 'Lead integrates' };

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-handoff-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite')); stores.push(store);
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) => store.append({ id: `HS-${++n}`, goalId: spec.id, type, data, at: new Date().toISOString() });
  return { dir, store, add };
}

/** Records every call; the old dispatch is live until stopped. */
function fakeRuntime(options: { stop?: 'stopped' | 'unknown'; failStart?: boolean; settled?: boolean } = {}) {
  const calls: string[] = [];
  const handoffs: HandoffInput[] = [];
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startLead() { throw new Error('no'); }, async resumeSolo() { throw new Error('no'); },
    async inspect(r) { return options.settled ? { state: 'settled', outcome: 'failed', ref: r } : { state: 'live', ref: r }; },
    async stopWorker(dispatchId) { calls.push(`stop ${dispatchId}`); return options.stop ?? 'stopped'; },
    async handoff(input) {
      calls.push(`handoff ${input.kind}`); handoffs.push(input);
      if (options.failStart) throw new Error('Orca orchestration worker-start failed');
      return { runId: input.runId, taskId: 't2', dispatchId: 'ctx_2', owner: 'lead', repoPath: input.repoPath, terminal: 'term_2', worktreeId: input.worktreeId, baseCommit: input.baseCommit, requested: { agent: 'claude' } };
    },
    async startPackage() { throw new Error('no'); }
  };
  return { runtime, calls, handoffs };
}

function soloExecuting(add: (type: GoalEventType, data?: unknown) => void, dir: string) {
  const lead = { runId: 'run_1', taskId: 't1', dispatchId: 'ctx_1', repoPath: dir, terminal: 'term_1', worktreeId: 'repo::C:/wt', baseCommit: BASE, requested: { agent: 'codex', model: 'gpt-6.1-terra' } };
  add('goal-drafted', spec); add('goal-approved', approval); add('goal-selected'); add('lead-dispatch-intended', 'lk'); add('lead-started', lead);
  add('proposal-drafted', proposal); add('proposal-approved'); add('execution-started', { ...lead, owner: 'lead' });
}

const claude: RuntimeProfiles = { ...DEFAULT_PROFILES, lead: { agent: 'claude' } };

describe('HandoffService', () => {
  it('stops the stuck owner and starts the role profile on the same worktree, without spending an attempt', async () => {
    const { dir, store, add } = open();
    soloExecuting(add, dir);
    const { runtime, calls, handoffs } = fakeRuntime();
    const result = await new HandoffService(store, runtime, () => claude).handoff(spec.id, { kind: 'lead' }, dir);
    expect(result).toEqual({ dispatchId: 'ctx_2' });
    expect(calls).toEqual(['stop ctx_1', 'handoff solo-owner']);
    expect(handoffs[0]).toMatchObject({ role: 'lead', worktreeId: 'repo::C:/wt', runId: 'run_1', baseCommit: BASE, attempt: 1, fromAgent: 'codex', goalVersion: 1 });
    const state = store.getGoal(spec.id)!;
    expect(state.runtimeRef).toMatchObject({ dispatchId: 'ctx_2' });
    expect(state.soloAttempts).toBe(1);
    expect(state.handoffIntent).toBeUndefined();
  });

  it('refuses to start a new agent when the old one may still run', async () => {
    const { dir, store, add } = open();
    soloExecuting(add, dir);
    const { runtime, calls } = fakeRuntime({ stop: 'unknown' });
    await expect(new HandoffService(store, runtime, () => claude).handoff(spec.id, { kind: 'lead' }, dir)).rejects.toThrow(/Could not confirm the old agent stopped/);
    expect(calls).toEqual(['stop ctx_1']);
    expect(store.events(spec.id).map(item => item.type)).toContain('intent-abandoned');
    expect(store.getGoal(spec.id)!.handoffIntent).toBeUndefined();
  });

  it('keeps the intent and says to retry when the new agent may not have started (the old one is already stopped)', async () => {
    const { dir, store, add } = open();
    soloExecuting(add, dir);
    const { runtime } = fakeRuntime({ failStart: true });
    await expect(new HandoffService(store, runtime, () => claude).handoff(spec.id, { kind: 'lead' }, dir)).rejects.toThrow(/Run apos handoff again/);
    expect(store.getGoal(spec.id)!.handoffIntent).toBeDefined();
    expect(store.getGoal(spec.id)!.status).toBe('executing');
  });

  it('clears a block caused by that dispatch failing, but not other blocks', async () => {
    const first = open();
    soloExecuting(first.add, first.dir);
    first.add('blocked', { kind: 'technical', note: 'needs-decision: owner reported failed on attempt 1 without a delivery report' });
    const settled = fakeRuntime({ settled: true });
    await new HandoffService(first.store, settled.runtime, () => claude).handoff(spec.id, { kind: 'lead' }, first.dir);
    expect(settled.calls).toEqual(['handoff solo-owner']); // already settled: nothing to stop
    expect(first.store.getGoal(spec.id)!.status).toBe('executing');

    const other = open();
    soloExecuting(other.add, other.dir);
    other.add('blocked', { kind: 'technical', note: 'needs-decision: attempt budget 3 spent' });
    await expect(new HandoffService(other.store, fakeRuntime().runtime, () => claude).handoff(spec.id, { kind: 'lead' }, other.dir)).rejects.toThrow(/blocked for another reason/);
  });

  it('hands a package to its Worker profile, with its contract', async () => {
    const { dir, store, add } = open();
    add('goal-drafted', spec); add('goal-approved', approval); add('goal-selected'); add('proposal-drafted', { ...proposal, mode: 'multi-wp' });
    add('package-added', { ...pkg, version: 1 }); add('package-added', { ...pkg, id: 'WP-02', version: 1, owner: 'worker-b', scope: ['history'], acceptance: [{ id: 'WP-AC-2', text: 'h' }] }); add('proposal-approved');
    add('package-dispatch-intended', { packageId: 'WP-01', key: 'k' });
    add('package-started', { packageId: 'WP-01', ref: { runId: 'run_p', taskId: 'p', dispatchId: 'ctx_p', owner: 'worker', repoPath: dir, worktreeId: 'repo::C:/p', baseCommit: BASE, requested: { agent: 'codex' } } });
    const { runtime, handoffs } = fakeRuntime();
    const result = await new HandoffService(store, runtime, () => ({ ...DEFAULT_PROFILES, worker: { agent: 'codex' } })).handoff(spec.id, { kind: 'package', packageId: 'WP-01' }, dir);
    expect(handoffs[0]).toMatchObject({ kind: 'worker', role: 'worker', packageId: 'WP-01', packageVersion: 1, owner: 'worker-a', outcome: 'QR intake', attempt: 1, worktreeId: 'repo::C:/p', runId: 'run_p' });
    expect(result.warning).toMatch(/same agent and model/);
    expect(store.getGoal(spec.id)!.packages!['WP-01']).toMatchObject({ attempts: 1, runtimeRef: { dispatchId: 'ctx_2' } });
  });
});
