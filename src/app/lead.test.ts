import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { ProjectJournal } from '../store/journal.js';
import { approval, proposal, sourceText, spec } from '../domain/fixtures.test-support.js';
import { applyEvent, type GoalEvent, type GoalEventType } from '../domain/transitions.js';
import { LeadService, LEAD_IDLE_MINUTES, LEAD_INTENT_MINUTES } from './lead.js';
import { ControllerService } from './controller.js';
import { assertExecutionSettled } from './replan.js';
import { OrcaRefused } from '../runtime/orca/exec.js';
import { runCli } from '../cli.js';
import type { PackageRuntime, RuntimeAdapter, RuntimeObservation } from '../ports/runtime.js';
import type { RuntimeRef } from '../domain/runtime-refs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  delete process.env.ORCA_TERMINAL_HANDLE;
});

const BASE = 'c'.repeat(40);
const leadRef = (dispatchId = 'lead_1'): RuntimeRef => ({
  runId: 'run_lead',
  taskId: 'task_lead',
  dispatchId,
  owner: 'lead',
  repoPath: 'C:/project',
  terminal: 'term_lead',
  worktreeId: 'repo::C:/lead-wt',
  baseCommit: BASE,
  requested: { agent: 'codex', model: 'gpt-6.1-terra' },
});

/** A scripted Orca: what startLead does, what inspect says, and every call made. */
class FakeOrca implements RuntimeAdapter, PackageRuntime {
  calls: string[] = [];
  start: 'ok' | 'refuse' | 'lost' = 'ok';
  recovered?: RuntimeRef;
  observation: Omit<RuntimeObservation, 'ref'> = { state: 'live' };
  wakes: { terminal: string; worktree: string; events: string[]; phase?: string }[] = [];
  async startLead(): Promise<RuntimeRef> {
    this.calls.push('startLead');
    if (this.start === 'refuse') throw new OrcaRefused('agent_unconfigured', 'agent_unconfigured');
    if (this.start === 'lost') throw new Error('Orca orchestration worker-start failed: state=outcome_unknown');
    return leadRef();
  }
  async resumeSolo(): Promise<RuntimeRef> {
    this.calls.push('resumeSolo');
    return leadRef();
  }
  async recover(): Promise<RuntimeRef | undefined> {
    this.calls.push('recover');
    return this.recovered;
  }
  async inspect(ref: RuntimeRef): Promise<RuntimeObservation> {
    this.calls.push(`inspect:${ref.dispatchId}`);
    return { ...this.observation, ref };
  }
  replies: { runId: string; messageId: string; body: string }[] = [];
  async replyMessage(runId: string, messageId: string, body: string) {
    this.replies.push({ runId, messageId, body });
  }
  async retainWorker(dispatchId: string) {
    this.calls.push(`retain:${dispatchId}`);
  }
  async wakeLead(input: { terminal: string; worktree: string; events: string[]; phase?: 'plan' | 'multi' }) {
    this.wakes.push(input);
    return { dispatchId: `wake_${this.wakes.length}` };
  }
  async startPackage(): Promise<never> {
    throw new Error('no packages');
  }
  async resumePackage(): Promise<never> {
    throw new Error('no packages');
  }
}

function fixture(now = () => Date.parse('2026-11-14T00:00:00.000Z')) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-lead-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: GoalEventType, data?: unknown, at = '2026-11-14T00:00:00.000Z') =>
    store.append({ id: `L-${++n}`, goalId: spec.id, type, data, at });
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  const orca = new FakeOrca();
  return { dir, store, add, orca, service: new LeadService(store, orca, now) };
}

describe('dispatching the Lead (design: lead-owns-solo)', () => {
  it('dispatches one Lead per Goal version, however often it is asked (I1)', async () => {
    const { store, orca, service, dir } = fixture();
    expect((await service.start(spec.id, dir)).dispatchId).toBe('lead_1');
    expect((await service.start(spec.id, dir)).dispatchId).toBe('lead_1');
    expect(orca.calls.filter(call => call === 'startLead')).toHaveLength(1);
    expect(store.getGoal(spec.id)).toMatchObject({
      lead: { current: 'lead_1', ref: { terminal: 'term_lead', baseCommit: BASE } },
      leadTerminal: { terminal: 'term_lead', worktree: 'id:repo::C:/lead-wt', runId: 'run_lead' },
    });
    expect(() =>
      store.append({
        id: 'dup',
        goalId: spec.id,
        type: 'lead-dispatch-intended',
        data: 'k2',
        at: '2026-11-14T00:00:01.000Z',
      }),
    ).toThrow(/already dispatched/);
    store.close();
  });

  it('drops an intent Orca refused, so the Human can retry with lead start (F2)', async () => {
    const { store, orca, service, dir } = fixture();
    orca.start = 'refuse';
    await expect(service.start(spec.id, dir)).rejects.toThrow(/agent_unconfigured/);
    expect(store.getGoal(spec.id)?.leadIntent).toBeUndefined();
    orca.start = 'ok';
    expect((await service.start(spec.id, dir)).dispatchId).toBe('lead_1');
    store.close();
  });

  it('keeps a lost dispatch for recovery by key, never starts a second Lead, and asks the Human after 10 min (F1)', async () => {
    let now = Date.parse('2026-11-14T00:00:00.000Z');
    const { store, orca, service, dir } = fixture(() => now);
    orca.start = 'lost';
    await expect(service.start(spec.id, dir)).rejects.toThrow(/outcome_unknown/);
    const key = store.getGoal(spec.id)!.leadIntent!;
    expect(key).toBeTruthy();
    await expect(service.start(spec.id, dir)).rejects.toThrow(/outcome unknown/);
    expect(orca.calls.filter(call => call === 'startLead')).toHaveLength(1);
    now += (LEAD_INTENT_MINUTES + 1) * 60_000;
    expect(await service.reconcile(spec.id)).toEqual(['Lead dispatch unknown; Human notified']);
    expect(await service.reconcile(spec.id)).toEqual([]);
    orca.recovered = leadRef('lead_recovered');
    expect(await service.reconcile(spec.id)).toEqual(['recovered Lead lead_recovered']);
    expect(store.getGoal(spec.id)).toMatchObject({ leadIntent: undefined, lead: { current: 'lead_recovered' } });
    store.close();
  });
});

describe('a Lead that ends its turn before its plan is accepted (Q4)', () => {
  it('records it, keeps its terminal, tells the Human once, and wakes the same terminal with the decision (F4)', async () => {
    const { store, orca, service, dir } = fixture();
    await service.start(spec.id, dir);
    expect(await service.reconcile(spec.id)).toEqual([]);
    orca.observation = { state: 'settled', outcome: 'failed' };
    expect(await service.reconcile(spec.id)).toEqual([
      'Lead lead_1 settled failed before a plan was accepted; Human notified',
    ]);
    expect(orca.calls).toContain('retain:lead_1');
    expect(await service.reconcile(spec.id)).toEqual([]);
    expect(
      store
        .events(spec.id)
        .filter(
          item => item.type === 'human-notified' && (item.data as { kind: string }).kind === 'lead-needs-decision',
        ),
    ).toHaveLength(1);
    expect(await service.wake(spec.id, dir, 'appetite raised to 300 min')).toBe('wake_1');
    expect(orca.wakes[0]).toMatchObject({ terminal: 'term_lead', worktree: 'id:repo::C:/lead-wt', phase: 'plan' });
    expect(orca.wakes[0].events[0]).toMatch(/appetite raised to 300 min/);
    expect(store.getGoal(spec.id)?.lead).toMatchObject({ current: 'wake_1', settled: undefined });
    await expect(service.wake(spec.id, dir, 'again')).rejects.toThrow(/still in its turn/);
    store.close();
  });

  it('answers the pending Lead question with lead wake instead of refusing (GitHub #3)', async () => {
    const { store, add, orca, service, dir } = fixture();
    await service.start(spec.id, dir);
    add('human-notified', { kind: 'lead-question', goalId: spec.id, messageId: 'msg-q', subject: 'Which database?' });
    expect(await service.wake(spec.id, dir, 'use sqlite')).toBe('lead_1');
    expect(orca.replies).toEqual([{ runId: 'run_lead', messageId: 'msg-q', body: 'use sqlite' }]);
    expect(orca.wakes).toEqual([]);
    await expect(service.wake(spec.id, dir, 'again')).rejects.toThrow(/still in its turn/);
    store.close();
  });

  it('does not answer a question the Lead asked before its latest wake (stale question)', async () => {
    const { store, add, orca, service, dir } = fixture();
    await service.start(spec.id, dir);
    add('human-notified', { kind: 'lead-question', goalId: spec.id, messageId: 'msg-old', subject: 'old' });
    add('lead-woken', { dispatchId: 'lead_2', events: [] });
    await expect(service.wake(spec.id, dir, 'hello')).rejects.toThrow(/still in its turn/);
    expect(orca.replies).toEqual([]);
    store.close();
  });

  it('reports a Lead idle past the quiet spell once, and a planning phase past the wall time once (F3, F12)', async () => {
    let now = Date.parse('2026-11-14T00:00:00.000Z');
    const { store, orca, service, dir } = fixture(() => now);
    await service.start(spec.id, dir);
    orca.observation = { state: 'live', idleMinutes: LEAD_IDLE_MINUTES };
    expect(await service.reconcile(spec.id)).toEqual(['Lead lead_1 idle; Human notified']);
    expect(await service.reconcile(spec.id)).toEqual([]);
    orca.observation = { state: 'live' };
    now += (approval.appetite.maxWallMinutes + 1) * 60_000;
    expect(await service.reconcile(spec.id)).toEqual(['notified overrun']);
    expect(await service.reconcile(spec.id)).toEqual([]);
    store.close();
  });
});

describe('the Solo owner is the Lead', () => {
  it('is adopted by the controller without a new dispatch; its end of turn is a delivery, not a planning stop (I2)', async () => {
    const { store, add, orca, dir } = fixture();
    add('lead-dispatch-intended', 'k');
    add('lead-started', leadRef());
    add('proposal-drafted', { ...proposal, baseCommit: BASE });
    add('proposal-approved');
    orca.observation = { state: 'settled', outcome: 'completed' };
    const [tick] = await new ControllerService(store, orca).tick(dir);
    expect(tick.dispatched).toEqual(['lead_1']);
    expect(orca.calls).not.toContain('startLead');
    expect((await new ControllerService(store, orca).tick(dir))[0].settled).toEqual(['solo:completed']);
    const state = store.getGoal(spec.id)!;
    expect(state).toMatchObject({
      runtimeRef: { dispatchId: 'lead_1', terminal: 'term_lead' },
      settlements: { lead_1: 'completed' },
    });
    expect(state.lead?.settled).toBeUndefined(); // a delivery for the gate, not a Lead that stopped planning
    expect(store.events(spec.id).some(item => item.type === 'lead-settled')).toBe(false);
    store.close();
  });

  it('refuses a Solo owner other than the current Lead dispatch', () => {
    let state = undefined as ReturnType<typeof applyEvent> | undefined;
    let n = 0;
    const event = (type: GoalEventType, data?: unknown): GoalEvent => ({
      id: `E-${++n}`,
      goalId: spec.id,
      type,
      data,
      at: '2026-11-14T00:00:00.000Z',
    });
    for (const [type, data] of [
      ['goal-drafted', spec],
      ['goal-approved', approval],
      ['goal-selected', undefined],
      ['lead-dispatch-intended', 'k'],
      ['lead-started', leadRef()],
      ['proposal-drafted', proposal],
      ['proposal-approved', undefined],
    ] as [GoalEventType, unknown][])
      state = applyEvent(state, event(type, data));
    expect(() => applyEvent(state, event('execution-started', { ...leadRef('cold_owner') }))).toThrow(
      /current Lead dispatch/,
    );
    expect(applyEvent(state, event('execution-started', leadRef())).status).toBe('executing');
  });

  it('tells the Human, once, about an accepted Solo plan no running Lead owns (migration), and starts nothing', async () => {
    const { store, add, orca, dir } = fixture();
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const controller = new ControllerService(store, orca);
    expect((await controller.tick(dir))[0].unresolved).toEqual(['Solo plan without a Lead']);
    await controller.tick(dir);
    expect(orca.calls).not.toContain('startLead');
    expect(
      store
        .events(spec.id)
        .filter(item => item.type === 'human-notified' && /apos lead start/.test(JSON.stringify(item.data))),
    ).toHaveLength(1);
    store.close();
  });
});

describe('changing the Goal while its Lead runs (F10)', () => {
  it('waits for the Lead to end its turn, then lets the Goal be revised and forgets that Lead', async () => {
    const { store, orca, service, dir } = fixture();
    await service.start(spec.id, dir);
    await expect(assertExecutionSettled(store.getGoal(spec.id)!, orca, { includeLead: true })).rejects.toThrow(
      /Lead must end its turn/,
    );
    await expect(assertExecutionSettled(store.getGoal(spec.id)!, orca)).resolves.toBeUndefined(); // the Lead revising its own plan
    orca.observation = { state: 'settled', outcome: 'completed' };
    await expect(assertExecutionSettled(store.getGoal(spec.id)!, orca, { includeLead: true })).resolves.toBeUndefined();
    store.append({
      id: 'rev',
      goalId: spec.id,
      type: 'goal-revised',
      data: { ...spec, version: 2 },
      at: '2026-11-14T00:01:00.000Z',
    });
    const revised = store.getGoal(spec.id)!;
    expect(revised.status).toBe('draft');
    expect(revised.lead).toBeUndefined();
    expect(revised.leadTerminal).toBeUndefined();
    store.close();
  });
});

describe('rollback safety (rollout step 0)', () => {
  it('replays a log holding an event type this version does not know, instead of losing the Goal', () => {
    let state = applyEvent(undefined, {
      id: 'a',
      goalId: spec.id,
      type: 'goal-drafted',
      data: spec,
      at: '2026-11-14T00:00:00.000Z',
    });
    state = applyEvent(state, {
      id: 'b',
      goalId: spec.id,
      type: 'from-a-newer-apos' as GoalEventType,
      data: {},
      at: '2026-11-14T00:00:01.000Z',
    });
    state = applyEvent(state, {
      id: 'c',
      goalId: spec.id,
      type: 'goal-approved',
      data: approval,
      at: '2026-11-14T00:00:02.000Z',
    });
    expect(state.status).toBe('approved');
  });
});

describe('the Lead terminal through the CLI (I3, I5)', () => {
  it('accepts lead propose and commit only from the dispatched Lead terminal, at the Lead base', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-lead-cli-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q', dir]);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    const orca = new FakeOrca();
    let base = '';
    orca.startLead = async () => {
      orca.calls.push('startLead');
      base = git('rev-parse', 'HEAD');
      return { ...leadRef(), repoPath: dir, baseCommit: base };
    };
    const output: string[] = [];
    const invoke = (...args: string[]) =>
      runCli(['--repo', dir, ...args], { runtime: orca, write: line => output.push(line) });
    writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
    writeFileSync(join(dir, 'brief.md'), sourceText);
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.json\nbrief.md\n');
    await invoke('init');
    await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
    await invoke(
      'goal',
      'approve',
      spec.id,
      '--size',
      'S',
      '--max-spend',
      '5',
      '--max-minutes',
      '60',
      '--max-attempts',
      '2',
    );
    await invoke('goal', 'select', spec.id);
    expect(output.at(-1)).toBe(`Dispatched Lead ${spec.id}: lead_1`);
    const head = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(proposal));
    // Main moves on while the Lead plans: the plan still gates against the code the Lead read (F7).
    git('commit', '-q', '--allow-empty', '-m', 'someone else');
    process.env.ORCA_TERMINAL_HANDLE = 'term_other';
    await expect(invoke('lead', 'propose', '--file', join(dir, 'plan.json'))).rejects.toThrow(/term_lead/);
    process.env.ORCA_TERMINAL_HANDLE = 'term_lead';
    writeFileSync(join(dir, 'stale.json'), JSON.stringify({ ...proposal, baseCommit: git('rev-parse', 'HEAD') }));
    await expect(invoke('lead', 'propose', '--file', join(dir, 'stale.json'))).rejects.toThrow(
      /differs from the Lead's worktree base/,
    );
    await invoke('lead', 'propose', '--file', join(dir, 'plan.json'));
    await expect(invoke('lead', 'commit', spec.id, '--terminal', 'term_other')).rejects.toThrow(
      /not the Lead terminal/,
    );
    await invoke('lead', 'commit', spec.id);
    const opened = ProjectJournal.open(dir);
    try {
      expect(opened.journal.getGoal(spec.id)).toMatchObject({
        status: 'executing',
        proposal: { baseCommit: base },
        runtimeRef: { dispatchId: 'lead_1', baseCommit: base },
      });
    } finally {
      opened.close();
    }
    expect(base).toBe(head);
    expect(orca.calls.filter(call => call === 'startLead')).toHaveLength(1);
  }, 60_000);
});
