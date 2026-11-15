import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, approval } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import { OrcaRefused } from '../runtime/orca.js';
import { DEFAULT_PROFILES, packageReportPath } from '../runtime/brief.js';
import { HandoffService } from './handoff.js';
import { MultiSupervisor } from './multi-supervisor.js';
import { ControllerService } from './controller.js';
import type { HandoffInput, PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import type { RuntimeRef } from '../domain/runtime-refs.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const BASE = 'b'.repeat(40);
const pkg: WorkPackageSpec = {
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
  ...pkg,
  id: 'WP-02',
  owner: 'worker-b',
  scope: ['history'],
  acceptance: [{ id: 'WP-AC-2', text: 'h' }],
};
const leadRef = (dir: string) => ({
  runId: 'run_lead',
  taskId: 'tl',
  dispatchId: 'ctx_lead',
  repoPath: dir,
  terminal: 'term_lead',
  worktreeId: 'repo::C:/lead',
  baseCommit: BASE,
  requested: { agent: 'codex' },
});

function open(at = () => new Date().toISOString()) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-fixes-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  stores.push(store);
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    store.append({ id: `RF-${++n}`, goalId: spec.id, type, data, at: at() });
  return { dir, store, add };
}

function multiWithLead(add: (type: GoalEventType, data?: unknown) => void, dir: string) {
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  add('lead-dispatch-intended', 'lk');
  add('lead-started', leadRef(dir));
  add('proposal-drafted', { ...proposal, mode: 'multi-wp' });
  add('package-added', pkg);
  add('package-added', second);
  add('proposal-approved');
  add('package-dispatch-intended', { packageId: 'WP-01', key: 'k1' });
  add('package-started', {
    packageId: 'WP-01',
    ref: {
      runId: 'run_p',
      taskId: 'p',
      dispatchId: 'ctx_p',
      owner: 'worker',
      repoPath: dir,
      worktreeId: 'repo::C:/p',
      baseCommit: BASE,
      requested: { agent: 'codex' },
    },
  });
}

function soloExecuting(add: (type: GoalEventType, data?: unknown) => void, dir: string) {
  const lead = leadRef(dir);
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  add('lead-dispatch-intended', 'lk');
  add('lead-started', lead);
  add('proposal-drafted', proposal);
  add('proposal-approved');
  add('execution-started', { ...lead, owner: 'lead' });
}

describe('Critical 1: a handed-off Multi-WP Lead is watched, retained and woken on its new terminal', () => {
  it('holds wakes while the new Lead runs, then retains it and wakes it on its own terminal', async () => {
    const { dir, store, add } = open();
    multiWithLead(add, dir);
    add('handoff-intended', { key: 'h1', target: { kind: 'lead' }, from: 'ctx_lead' });
    add('owner-handed-off', {
      key: 'h1',
      target: { kind: 'lead' },
      from: 'ctx_lead',
      ref: {
        runId: 'run_lead',
        taskId: 't9',
        dispatchId: 'ctx_9',
        owner: 'lead',
        repoPath: dir,
        terminal: 'term_9',
        worktreeId: 'repo::C:/lead',
        baseCommit: BASE,
        requested: { agent: 'claude' },
      },
    });
    const live = new Set(['ctx_9', 'ctx_p']);
    const inspected: string[] = [];
    const retained: string[] = [];
    const wakes: { terminal: string; events: string[] }[] = [];
    const runtime: RuntimeAdapter & PackageRuntime = {
      async startLead() {
        throw new Error('no');
      },
      async resumeSolo() {
        throw new Error('no');
      },
      async inspect(r) {
        inspected.push(r.dispatchId);
        return live.has(r.dispatchId) ? { state: 'live', ref: r } : { state: 'settled', outcome: 'completed', ref: r };
      },
      async retainWorker(id) {
        retained.push(id);
      },
      async wakeLead(input) {
        wakes.push({ terminal: input.terminal, events: input.events });
        return { dispatchId: 'ctx_w1' };
      },
      async startPackage() {
        throw new Error('no');
      },
      async inspectPackage() {
        return 'live';
      },
    };
    const supervisor = new MultiSupervisor(store, runtime, { now: () => Date.now() });
    const held = await supervisor.step(spec.id, dir, ['msg_1']);
    expect(inspected).toContain('ctx_9');
    expect(held.some(item => /Lead busy/.test(item))).toBe(true);
    expect(wakes).toEqual([]);
    live.delete('ctx_9');
    await supervisor.step(spec.id, dir, ['msg_1']);
    expect(retained).toContain('ctx_9');
    expect(wakes).toEqual([{ terminal: 'term_9', events: ['question msg_1'] }]);
  });
});

/** Runtime for HandoffService tests: the old dispatch is live until stopped. */
function handoffRuntime(
  options: {
    start?: () => Promise<RuntimeRef>;
    recover?: (key: string) => RuntimeRef | undefined;
    settled?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const keys: string[] = [];
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startLead() {
      throw new Error('no');
    },
    async resumeSolo() {
      throw new Error('no');
    },
    async inspect(r) {
      return options.settled || calls.includes(`stop ${r.dispatchId}`)
        ? { state: 'settled', outcome: 'failed', ref: r }
        : { state: 'live', ref: r };
    },
    async stopWorker(id) {
      calls.push(`stop ${id}`);
      return 'stopped';
    },
    async recover(key) {
      calls.push(`recover ${key}`);
      return options.recover?.(key);
    },
    async recoverPackage(key) {
      calls.push(`recover ${key}`);
      const found = options.recover?.(key);
      return found ? { ...found, owner: 'worker' } : undefined;
    },
    async handoff(input: HandoffInput) {
      calls.push(`handoff ${input.kind}`);
      keys.push(input.idempotencyKey);
      return options.start
        ? options.start()
        : {
            runId: input.runId,
            taskId: 't2',
            dispatchId: 'ctx_2',
            owner: 'lead',
            repoPath: input.repoPath,
            terminal: 'term_2',
            worktreeId: input.worktreeId,
            baseCommit: input.baseCommit,
            requested: { agent: 'claude' },
          };
    },
    async startPackage() {
      throw new Error('no');
    },
  };
  return { runtime, calls, keys };
}
const claude = () => ({ ...DEFAULT_PROFILES, lead: { agent: 'claude' } });

describe('Critical 2: a lost start response keeps the intent and is recovered by key, never started twice', () => {
  it('keeps the intent when the start outcome is unknown, and the next handoff recovers the started agent', async () => {
    const { dir, store, add } = open();
    soloExecuting(add, dir);
    let started: RuntimeRef | undefined;
    const lost = handoffRuntime({
      start: async () => {
        started = {
          runId: 'run_lead',
          taskId: 't2',
          dispatchId: 'ctx_2',
          owner: 'lead',
          repoPath: dir,
          terminal: 'term_2',
          worktreeId: 'repo::C:/lead',
        };
        throw new Error('Orca orchestration worker-start failed: state=timeout');
      },
      recover: key => (started ? ({ ...started, key } as RuntimeRef) : undefined),
    });
    await expect(
      new HandoffService(store, lost.runtime, claude).handoff(spec.id, { kind: 'lead' }, dir),
    ).rejects.toThrow(/outcome is unknown/);
    const pending = store.getGoal(spec.id)!.handoffIntent;
    expect(pending).toBeDefined();
    const retry = handoffRuntime({ recover: () => started });
    const result = await new HandoffService(store, retry.runtime, claude).handoff(spec.id, { kind: 'lead' }, dir);
    expect(result.dispatchId).toBe('ctx_2');
    expect(retry.calls).toEqual([`recover ${pending!.key}`]);
    expect(store.getGoal(spec.id)!.runtimeRef).toMatchObject({ dispatchId: 'ctx_2', requested: { agent: 'claude' } });
    expect(store.getGoal(spec.id)!.handoffIntent).toBeUndefined();
  });

  it('after a confirmed stop and an Orca refusal, keeps the intent and the retry starts with the same key', async () => {
    const { dir, store, add } = open();
    soloExecuting(add, dir);
    const refused = handoffRuntime({
      start: async () => {
        throw new OrcaRefused('no capacity', 'agent_unconfigured');
      },
    });
    await expect(
      new HandoffService(store, refused.runtime, claude).handoff(spec.id, { kind: 'lead' }, dir),
    ).rejects.toThrow(/Run apos handoff again/);
    const pending = store.getGoal(spec.id)!.handoffIntent!;
    expect(pending).toBeDefined();
    const retry = handoffRuntime({ settled: true });
    await new HandoffService(store, retry.runtime, claude).handoff(spec.id, { kind: 'lead' }, dir);
    expect(retry.calls).toEqual([`recover ${pending.key}`, 'handoff solo-owner']);
    expect(retry.keys).toEqual([pending.key]);
  });
});

describe('Important 1: a handoff left pending is reported', () => {
  it('tells the Human once when a handoff intent is older than 10 minutes', async () => {
    let now = Date.parse('2026-11-14T00:00:00.000Z');
    const { dir, store, add } = open(() => new Date(now).toISOString());
    soloExecuting(add, dir);
    add('handoff-intended', { key: 'h1', target: { kind: 'lead' }, from: 'ctx_lead' });
    const runtime: RuntimeAdapter = {
      async startLead() {
        throw new Error('no');
      },
      async resumeSolo() {
        throw new Error('no');
      },
      async inspect(r) {
        return { state: 'live', ref: r };
      },
    };
    const controller = new ControllerService(store, runtime, { now: () => now });
    await controller.tick(dir);
    const pendingNotices = () =>
      store
        .events(spec.id)
        .filter(item => item.type === 'human-notified' && (item.data as { kind?: string; key?: string }).key === 'h1');
    expect(pendingNotices()).toHaveLength(0);
    now += 11 * 60_000;
    await controller.tick(dir);
    await controller.tick(dir);
    expect(pendingNotices()).toHaveLength(1);
    expect(String((pendingNotices()[0].data as { note: string }).note)).toMatch(
      /apos handoff GOAL-001.*abandon-intent GOAL-001 --key h1/s,
    );
  });
});

describe('Important 4: no handoff while another dispatch intent is pending', () => {
  it('refuses while a Solo resume is in flight', async () => {
    const { dir, store, add } = open();
    soloExecuting(add, dir);
    add('checkpointed', { phase: 'controller finding', progress: 'x', evidenceRefs: [], goalId: spec.id, attempt: 2 });
    add('resume-intended', 'rk');
    await expect(
      new HandoffService(store, handoffRuntime().runtime, claude).handoff(spec.id, { kind: 'lead' }, dir),
    ).rejects.toThrow(/resume .* pending/);
  });
});

describe('Important 6: a Worker that honestly reported failure is the Lead decision, not a handoff', () => {
  it('refuses to clear a package block when the failed Worker committed a delivery report', async () => {
    const { dir, store, add } = open();
    execFileSync('git', ['init', '-q', dir]);
    mkdirSync(join(dir, '.apos', 'goals', spec.id, 'evidence'), { recursive: true });
    writeFileSync(join(dir, packageReportPath(spec.id, 'WP-01', 1, 1)), '# failed honestly\n');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=W', '-c', 'user.email=w@x', 'commit', '-qm', 'report']);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    multiWithLead(add, dir);
    add('package-blocked', {
      packageId: 'WP-01',
      blocker: { kind: 'technical', note: 'Worker reported failed on WP-01 v1 attempt 1' },
    });
    const { runtime } = handoffRuntime({ settled: true });
    runtime.deliveryHead = async () => head;
    await expect(
      new HandoffService(store, runtime, () => DEFAULT_PROFILES).handoff(
        spec.id,
        { kind: 'package', packageId: 'WP-01' },
        dir,
      ),
    ).rejects.toThrow(/delivery report/);
  });
});
