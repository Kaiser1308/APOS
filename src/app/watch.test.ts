import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { approval, proposal, spec } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import { watchDispatch } from './watch.js';
import { MultiSupervisor } from './multi-supervisor.js';
import { SoloSupervisor } from './solo-supervisor.js';
import { LeadService } from './lead.js';
import type { PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import type { RuntimeRef } from '../domain/runtime-refs.js';

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
      'worker ctx_1 stopped on an error (claude); Human notified',
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
    expect(String(notices('owner-idle')[0].note)).toContain('omit `--agent`');
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
    expect(actions).toContain('lead ctx_1 stopped on an error (claude); Human notified');
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
    expect(actions).toContain('worker ctx_wp stopped on an error (claude); Human notified');
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
    expect(actions).toContain('lead ctx_lead stopped on an error (claude); Human notified');
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

describe('owner worktree progress observation (#27)', () => {
  it('records owner-progress-observed only when commits or dirty state change, without writing to the worktree', async () => {
    const { execFileSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const { buildStory } = await import('../ui/story.js');
    const { dir, store, add } = open();
    const wtDir = join(dir, 'owner-wt');
    execFileSync('git', ['init', '-q', wtDir]);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', wtDir, '-c', 'user.name=O', '-c', 'user.email=o@local', ...args], {
        encoding: 'utf8',
      }).trim();
    writeFileSync(join(wtDir, 'index.js'), 'export const v = 0;\n');
    git('add', 'index.js');
    git('commit', '-qm', 'base');
    const baseCommit = git('rev-parse', 'HEAD');

    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', { ...proposal, baseCommit });
    add('proposal-approved');
    const ref: RuntimeRef = {
      runId: 'r',
      taskId: 't',
      dispatchId: 'ctx_1',
      owner: 'lead',
      repoPath: dir,
      terminal: 'term_1',
      worktreeId: `repo::${wtDir}`,
      baseCommit,
      requested: { agent: 'antigravity' },
    };
    add('dispatch-intended', 'k');
    add('execution-started', ref);

    const sup = new SoloSupervisor(store, fakeRuntime(ref, { minutes: 1 }, {}), { now: () => T0 + 60_000 });
    // No new commits and clean worktree -> no event
    await sup.step(spec.id, dir);
    expect(store.events(spec.id).filter(e => e.type === 'owner-progress-observed')).toHaveLength(0);

    // Owner makes a commit
    writeFileSync(join(wtDir, 'index.js'), 'export const v = 1;\n');
    git('add', 'index.js');
    git('commit', '-qm', 'step 1: merge engine');
    const head1 = git('rev-parse', 'HEAD');

    await sup.step(spec.id, dir);
    const observed1 = store.events(spec.id).filter(e => e.type === 'owner-progress-observed');
    expect(observed1).toHaveLength(1);
    expect(observed1[0].data).toMatchObject({
      dispatchId: 'ctx_1',
      head: head1,
      dirty: false,
      commits: [expect.objectContaining({ hash: head1, subject: 'step 1: merge engine', filesChanged: 1 })],
    });
    expect(git('status', '--porcelain')).toBe('');

    // Unchanged worktree on next tick -> no duplicate event
    await sup.step(spec.id, dir);
    expect(store.events(spec.id).filter(e => e.type === 'owner-progress-observed')).toHaveLength(1);

    // Uncommitted change -> records new observation once
    writeFileSync(join(wtDir, 'next.js'), 'export const next = true;\n');
    await sup.step(spec.id, dir);
    expect(store.events(spec.id).filter(e => e.type === 'owner-progress-observed')).toHaveLength(2);
    expect(store.events(spec.id).filter(e => e.type === 'owner-progress-observed')[1].data).toMatchObject({
      head: head1,
      dirty: true,
      dirtyFiles: 1,
      commits: [],
      commitCount: 1,
      latest: expect.objectContaining({ hash: head1 }),
    });

    // A second commit records only that commit (not the first again), with the running total
    git('add', 'next.js');
    git('commit', '-qm', 'step 2: sync');
    const head2 = git('rev-parse', 'HEAD');
    await sup.step(spec.id, dir);
    const observed3 = store.events(spec.id).filter(e => e.type === 'owner-progress-observed')[2];
    expect(observed3.data).toMatchObject({
      head: head2,
      dirty: false,
      commitCount: 2,
      commits: [expect.objectContaining({ hash: head2, subject: 'step 2: sync', filesChanged: 1 })],
    });
    expect((observed3.data as { commits: unknown[] }).commits).toHaveLength(1);

    // Story view includes the worktree progress so the Owner card is not empty
    const story = buildStory(store as never, spec.id)!;
    expect(story.owners[0].entries.some(e => e.text.includes('step 2: sync'))).toBe(true);
  });
});
