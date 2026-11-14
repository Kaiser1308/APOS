import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { approval, proposal, spec } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import type { RuntimeAdapter, RuntimeRef } from '../runtime/orca.js';
import type { PackageRuntime } from './packages.js';
import { watchDispatch } from './watch.js';
import { MultiSupervisor, SoloSupervisor } from './supervisor.js';
import { LeadService } from './lead.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const QUOTA = "You've hit your weekly limit · resets 1am (Asia/Ho_Chi_Minh)";
const T0 = Date.parse('2026-11-14T00:00:00.000Z');

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-watch-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  stores.push(store);
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    store.append({ id: `W-${++n}`, goalId: spec.id, type, data, at: new Date(T0).toISOString() });
  const notices = (kind: string) =>
    store
      .events(spec.id)
      .filter(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === kind)
      .map(item => item.data as Record<string, unknown>);
  return { dir, store, add, notices };
}

/** A runtime whose dispatch is live and idle for `idle.minutes`, with `screen.quota` as the out-of-quota line, if any. */
function fakeRuntime(
  ref: RuntimeRef,
  idle: { minutes?: number },
  screen: { quota?: string },
  agents: (string | undefined)[] = [],
): RuntimeAdapter & PackageRuntime {
  return {
    async startLead() {
      return ref;
    },
    async resumeSolo() {
      return ref;
    },
    async inspect(r) {
      return { state: 'live', idleMinutes: idle.minutes, ref: r };
    },
    async agentQuota(_terminal, agent) {
      agents.push(agent);
      return screen.quota;
    },
    async startPackage() {
      throw new Error('unused');
    },
    async inspectPackage() {
      return 'live';
    },
  };
}

describe('watchDispatch', () => {
  const ref: RuntimeRef = {
    runId: 'r',
    taskId: 't',
    dispatchId: 'ctx_1',
    owner: 'lead',
    repoPath: 'C:/repo',
    terminal: 'term_1',
    requested: { agent: 'claude' },
  };
  const input = (repoPath: string) => ({
    goalId: spec.id,
    dispatchId: 'ctx_1',
    runId: 'r',
    repoPath,
    terminal: 'term_1',
    role: 'worker' as const,
    requested: { agent: 'claude' },
    packageId: 'WP-A',
    handoffHint: `apos handoff ${spec.id} --package WP-A --agent <other>`,
  });

  it('names an exhausted agent once per dispatch, only after two quiet minutes, and then never as owner-idle', async () => {
    const { dir, store, add, notices } = open();
    add('goal-drafted', spec);
    const idle = { minutes: 1 as number | undefined };
    const agents: (string | undefined)[] = [];
    const runtime = fakeRuntime(ref, idle, { quota: QUOTA }, agents);
    expect(await watchDispatch(store, runtime, () => T0, input(dir))).toEqual([]);
    idle.minutes = 3;
    expect(await watchDispatch(store, runtime, () => T0, input(dir))).toEqual([
      'worker ctx_1 out of quota (claude); Human notified',
    ]);
    expect(agents).toEqual(['claude']);
    expect(await watchDispatch(store, runtime, () => T0, input(dir))).toEqual([]);
    idle.minutes = 20;
    expect(await watchDispatch(store, runtime, () => T0, input(dir))).toEqual([]);
    expect(notices('agent-exhausted')).toHaveLength(1);
    expect(notices('agent-exhausted')[0]).toMatchObject({
      dispatchId: 'ctx_1',
      role: 'worker',
      agent: 'claude',
      packageId: 'WP-A',
      message: QUOTA,
    });
    expect(String(notices('agent-exhausted')[0].note)).toContain(`apos handoff ${spec.id} --package WP-A --agent`);
    expect(notices('owner-idle')).toHaveLength(0);
  });

  it('still reports a silent dispatch with no quota line as owner-idle at 15 minutes', async () => {
    const { dir, store, add, notices } = open();
    add('goal-drafted', spec);
    const idle = { minutes: 14 as number | undefined };
    const runtime = fakeRuntime(ref, idle, {});
    expect(await watchDispatch(store, runtime, () => T0, input(dir))).toEqual([]);
    idle.minutes = 16;
    expect(await watchDispatch(store, runtime, () => T0, input(dir))).toEqual([
      'worker ctx_1 idle 16 min; Human notified',
    ]);
    expect(notices('owner-idle')[0]).toMatchObject({
      dispatchId: 'ctx_1',
      packageId: 'WP-A',
      role: 'worker',
      idleMinutes: 16,
    });
    expect(await watchDispatch(store, runtime, () => T0, input(dir))).toEqual([]);
  });
});

describe('wired into every running dispatch', () => {
  it('the Solo owner', async () => {
    const { dir, store, add, notices } = open();
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const ref: RuntimeRef = {
      runId: 'r',
      taskId: 't',
      dispatchId: 'ctx_1',
      owner: 'lead',
      repoPath: dir,
      terminal: 'term_1',
      requested: { agent: 'claude' },
    };
    add('dispatch-intended', 'k');
    add('execution-started', ref);
    const actions = await new SoloSupervisor(store, fakeRuntime(ref, { minutes: 3 }, { quota: QUOTA }), {
      now: () => T0 + 60_000,
    }).step(spec.id, dir);
    expect(actions).toContain('lead ctx_1 out of quota (claude); Human notified');
    expect(String(notices('agent-exhausted')[0].note)).toContain(`apos handoff ${spec.id} --agent`);
  });

  it('a Multi-WP package Worker', async () => {
    const { dir, store, add, notices } = open();
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
      outcome: 'History',
      scope: ['history'],
      acceptance: [{ id: 'WP-AC-2', text: 'history' }],
    };
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', { ...proposal, mode: 'multi-wp' });
    add('package-added', pkg);
    add('package-added', second);
    add('proposal-approved');
    add('package-dispatch-intended', { packageId: 'WP-01', key: 'k1' });
    add('package-started', {
      packageId: 'WP-01',
      ref: {
        runId: 'run-1',
        taskId: 'WP-01',
        dispatchId: 'ctx_wp',
        owner: 'worker',
        repoPath: dir,
        terminal: 'term_wp',
        requested: { agent: 'claude' },
      },
    });
    const ref: RuntimeRef = { runId: 'run-1', taskId: 'x', dispatchId: 'ctx_wp', owner: 'lead', repoPath: dir };
    const actions = await new MultiSupervisor(store, fakeRuntime(ref, { minutes: 3 }, { quota: QUOTA }), {
      now: () => T0 + 60_000,
    }).step(spec.id, dir);
    expect(actions).toContain('worker ctx_wp out of quota (claude); Human notified');
    expect(notices('agent-exhausted')[0]).toMatchObject({ packageId: 'WP-01', role: 'worker' });
    expect(String(notices('agent-exhausted')[0].note)).toContain('--package WP-01');
  });

  it('a Lead still planning', async () => {
    const { dir, store, add, notices } = open();
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('lead-dispatch-intended', 'lk');
    const lead = {
      runId: 'r',
      taskId: 't',
      dispatchId: 'ctx_lead',
      repoPath: dir,
      terminal: 'term_lead',
      worktreeId: 'repo::C:/lead',
      baseCommit: 'a'.repeat(40),
      requested: { agent: 'claude' },
    };
    add('lead-started', lead);
    const ref: RuntimeRef = { ...lead, owner: 'lead' };
    const actions = await new LeadService(
      store,
      fakeRuntime(ref, { minutes: 3 }, { quota: QUOTA }),
      () => T0 + 60_000,
    ).reconcile(spec.id);
    expect(actions).toContain('lead ctx_lead out of quota (claude); Human notified');
    expect(notices('agent-exhausted')[0]).toMatchObject({ role: 'lead', agent: 'claude' });
    expect(notices('lead-idle')).toHaveLength(0);
  });
});

describe("Orca's own out-of-quota escalation (seen live 2026-11-14: Codex in an Orca chat)", () => {
  it('becomes one agent-exhausted notice for that dispatch, with no "keep working" reply', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { ControllerService } = await import('./controller.js');
    const raw = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../runtime/fixtures/screens/codex/quota-escalation.json', import.meta.url)),
        'utf8',
      ),
    );
    const { dir, store, add, notices } = open();
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const ref: RuntimeRef = {
      runId: 'run_1',
      taskId: 't',
      dispatchId: 'ctx_1',
      owner: 'lead',
      repoPath: dir,
      terminal: 'term_1',
      requested: { agent: 'codex', model: 'gpt-6.1-terra' },
    };
    add('dispatch-intended', 'k');
    add('execution-started', ref);
    const replies: string[] = [];
    const acked: string[] = [];
    const runtime: RuntimeAdapter = {
      async startLead() {
        return ref;
      },
      async resumeSolo() {
        return ref;
      },
      async inspect(r) {
        return { state: 'live', ref: r };
      },
      async checkRun() {
        return { deliveryId: 'd1', messages: [{ ...raw, payload: { ...raw.payload, dispatchId: 'ctx_1' } }] };
      },
      async ackRun(_run, delivery) {
        acked.push(delivery);
      },
      async retainWorker() {},
      async replyMessage(_run, _id, body) {
        replies.push(body);
      },
    };
    await new ControllerService(store, runtime).tick(dir);
    await new ControllerService(store, runtime).tick(dir);
    expect(notices('agent-exhausted')).toHaveLength(1);
    expect(notices('agent-exhausted')[0]).toMatchObject({
      dispatchId: 'ctx_1',
      role: 'lead',
      agent: 'codex',
      message: expect.stringMatching(/^You’ve hit your usage limit\. Upgrade to Pro/),
    });
    expect(String(notices('agent-exhausted')[0].note)).toContain(`apos handoff ${spec.id} --agent`);
    expect(notices('escalation')).toHaveLength(0);
    expect(replies).toEqual([]);
    expect(acked).toEqual(['d1', 'd1']);
  });
});

describe("quotaEscalation matches only Orca's own report", () => {
  it("ignores an agent's own escalation that talks about limits", async () => {
    const { quotaEscalation } = await import('./watch.js');
    expect(
      quotaEscalation({
        type: 'escalation',
        subject: 'Blocked: should a client that hit your rate limit get 429?',
        body: 'The spec is silent.',
      }),
    ).toBeUndefined();
    expect(
      quotaEscalation({
        type: 'escalation',
        subject: 'Agent hit an error: Claude hit its context limit.',
        body: 'Error: Claude hit its context limit.',
      }),
    ).toBeUndefined();
    expect(
      quotaEscalation({
        type: 'escalation',
        subject: 'Agent hit an error: Codex hit its usage limit.',
        body: 'Error: Codex hit its usage limit.\nDetails from the agent: You’ve hit your usage limit. Try again at 10:02 PM.',
      }),
    ).toBe('You’ve hit your usage limit. Try again at 10:02 PM.');
  });
});
