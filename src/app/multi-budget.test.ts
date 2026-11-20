import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../store/sqlite.js';
import { approval, gateReport, proposal, spec } from '../domain/fixtures.test-support.js';
import { attemptKey } from '../domain/gate.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import type { RuntimeRef } from '../domain/runtime-refs.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import { MultiSupervisor } from './multi-supervisor.js';
import { PackageService } from './package-service.js';

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

describe('a Goal reviewer whose start response was lost just before the wall limit', () => {
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-budget-review-'));
    dirs.push(dir);
    const store = SqliteStore.open(join(dir, 'state.sqlite'));
    let n = 0;
    const add = (type: GoalEventType, data?: unknown, at = '2026-11-07T00:00:00.000Z') =>
      store.append({ id: `R-${++n}`, goalId: spec.id, type, data, at });
    const wp = (id: string, owner: string, acceptance: WorkPackageSpec['acceptance']): WorkPackageSpec => ({
      id,
      goalId: spec.id,
      goalVersion: 1,
      version: 1,
      owner,
      outcome: id,
      scope: [id],
      exclusions: [],
      dependencies: [],
      interfaces: [`${id}@v1`],
      acceptance,
      integration: 'integrate',
    });
    const packages = [
      wp('WP-01', 'worker', [{ id: 'WP-AC-1', text: 'works', goalAcceptanceId: 'AC-1' }]),
      wp('WP-02', 'worker2', [{ id: 'WP-AC-2', text: 'second' }]),
    ];
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('lead-dispatch-intended', 'lead-key');
    add('proposal-drafted', { ...proposal, mode: 'multi-wp' });
    for (const item of packages) add('package-added', item);
    add('proposal-approved');
    const reviewers: string[] = [];
    const recovered: string[] = [];
    let found: RuntimeRef | undefined;
    const runtime: RuntimeAdapter & PackageRuntime = {
      async startLead() {
        throw new Error('unexpected');
      },
      async resumeSolo() {
        throw new Error('unexpected');
      },
      async startPackage(input) {
        return {
          runId: 'run',
          taskId: input.package.id,
          dispatchId: `ctx-${input.package.id}`,
          owner: 'worker',
          repoPath: dir,
        };
      },
      async inspect(ref) {
        return { state: 'live', ref };
      },
      async inspectPackage() {
        return 'completed' as const;
      },
      async recover(key) {
        recovered.push(key);
        return found;
      },
      async startReviewer() {
        reviewers.push('started');
        return { runId: 'run', taskId: 'review', dispatchId: 'reviewer-2', owner: 'lead', repoPath: dir };
      },
    };
    const service = new PackageService(store, runtime, () => Date.parse('2026-11-07T00:10:00.000Z'));
    await service.dispatchReady(spec.id, dir);
    for (const [item, commitRef] of [
      [packages[0], 'a'.repeat(40)],
      [packages[1], 'b'.repeat(40)],
    ] as const) {
      service.submitEvidence(spec.id, {
        packageId: item.id,
        packageVersion: 1,
        owner: item.owner,
        acceptanceId: item.acceptance[0].id,
        result: 'pass',
        command: 'test',
        artifactRef: 'log',
        commitRef,
      });
      await service.verify(spec.id, item.id);
    }
    const delivery = 'd'.repeat(40);
    add(
      'gate-recorded',
      { ...gateReport(delivery), attemptKey: attemptKey(store.getGoal(spec.id)!) },
      '2026-11-07T03:55:00.000Z',
    );
    add('review-intended', { key: 'review-key', commit: delivery }, '2026-11-07T03:59:00.000Z');
    const supervisor = new MultiSupervisor(store, runtime, { now: () => Date.parse('2026-11-07T05:00:00.000Z') });
    return {
      store,
      dir,
      supervisor,
      reviewers,
      recovered,
      setFound: (ref: RuntimeRef) => (found = ref),
    };
  };

  it('is still recovered by its key after the limit, so its review can be collected', async () => {
    const { store, dir, supervisor, reviewers, recovered, setFound } = await setup();
    setFound({ runId: 'run', taskId: 'review', dispatchId: 'reviewer-1', owner: 'lead', repoPath: dir });
    await supervisor.step(spec.id, dir);
    expect(store.events(spec.id).some(event => event.type === 'multi-time-exhausted')).toBe(true);
    expect(recovered).toEqual(['review-key']);
    expect(store.getGoal(spec.id)?.reviewDispatch?.dispatchId).toBe('reviewer-1');
    expect(reviewers).toEqual([]);
    store.close();
  });

  it('is not replaced by a new reviewer after the limit when it cannot be found', async () => {
    const { store, dir, supervisor, reviewers, recovered } = await setup();
    await supervisor.step(spec.id, dir);
    expect(recovered).toEqual(['review-key']);
    expect(reviewers).toEqual([]);
    expect(store.getGoal(spec.id)?.reviewIntent?.key).toBe('review-key');
    expect(store.events(spec.id).filter(event => event.type === 'review-intended')).toHaveLength(1);
    store.close();
  });
});
