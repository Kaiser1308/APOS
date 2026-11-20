import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../store/sqlite.js';
import { approval, proposal, spec } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import { MultiSupervisor } from './multi-supervisor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

it('does not launch a Lead wake after the wall limit, and wakes after the Human extends it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-budget-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    store.append({ id: `B-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  const wp = {
    id: 'WP-01',
    goalId: spec.id,
    goalVersion: 1,
    version: 1,
    owner: 'worker',
    outcome: 'work',
    scope: ['work'],
    exclusions: [],
    dependencies: [],
    interfaces: ['x@v1'],
    acceptance: [{ id: 'WP-AC-1', text: 'works', goalAcceptanceId: 'AC-1' }],
    integration: 'integrate',
  };
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  add('lead-dispatch-intended', 'lead-key');
  add('lead-started', {
    runId: 'lead-run',
    taskId: 'lead',
    dispatchId: 'lead-1',
    owner: 'lead',
    repoPath: dir,
    terminal: 'lead-terminal',
    worktreeId: `repo::${dir}`,
    baseCommit: 'b'.repeat(40),
  });
  add('proposal-drafted', { ...proposal, mode: 'multi-wp' });
  add('package-added', wp);
  add('package-added', { ...wp, id: 'WP-02', owner: 'worker2', acceptance: [{ id: 'WP-AC-2', text: 'second' }] });
  add('proposal-approved');
  add('package-dispatch-intended', { packageId: 'WP-01', key: 'k' });
  add('package-started', {
    packageId: 'WP-01',
    ref: { runId: 'run', taskId: 'task', dispatchId: 'wp-1', owner: 'worker', repoPath: dir },
  });
  let wakes = 0;
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startLead() {
      throw new Error('unexpected');
    },
    async resumeSolo() {
      throw new Error('unexpected');
    },
    async startPackage() {
      throw new Error('unexpected');
    },
    async inspect(ref) {
      return { state: 'live', ref };
    },
    async wakeLead() {
      wakes++;
      return { dispatchId: 'wake-1' };
    },
  };
  const supervisor = new MultiSupervisor(store, runtime, { now: () => Date.parse('2026-11-07T05:00:00.000Z') });
  await supervisor.step(spec.id, dir, ['question from worker']);
  expect(wakes).toBe(0);
  expect(store.events(spec.id).filter(event => event.type === 'multi-time-exhausted')).toHaveLength(1);
  add('appetite-set', { appetite: { ...approval.appetite, maxWallMinutes: 600 }, reason: 'Extend budget' });
  await supervisor.step(spec.id, dir, ['question from worker']);
  expect(wakes).toBe(1);
  store.close();
});
