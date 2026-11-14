import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { approval, proposal, spec } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';
import { OrcaRefused, isDeadSession, type RuntimeAdapter } from '../runtime/orca.js';
import type { PackageRuntime } from './packages.js';
import { MultiSupervisor } from './supervisor.js';
import { ControllerService } from './controller.js';
import { LeadService } from './lead.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
const dead = () => new OrcaRefused('Orca orchestration worker-start failed: [session_caller_not_live] Agent session has ended: its chat was closed.', 'session_caller_not_live');

function fixture(extra: (add: (type: GoalEventType, data?: unknown) => void, dir: string) => void = () => undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-dead-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) => store.append({ id: `D-${++n}`, goalId: spec.id, type, data, at: '2026-11-14T00:00:00.000Z' });
  add('goal-drafted', spec); add('goal-approved', approval); add('goal-selected');
  add('lead-dispatch-intended', 'k'); add('lead-started', { runId: 'run-1', taskId: 't', dispatchId: 'lead-1', owner: 'lead', repoPath: dir, terminal: 'term-lead', worktreeId: 'repo::wt', baseCommit: 'b'.repeat(40) });
  extra(add, dir);
  return { dir, store };
}
const runtime = (wake: () => Promise<never>): RuntimeAdapter & PackageRuntime => ({
  async startLead() { throw new Error('none'); }, async resumeSolo() { throw new Error('none'); },
  async inspect(ref) { return { state: 'live', ref }; },
  async startPackage() { throw new Error('none'); },
  async wakeLead() { return wake(); }
} as RuntimeAdapter & PackageRuntime);

describe('a wake on a session that has ended (GitHub #12, #13)', () => {
  it('isDeadSession recognises the Orca refusal', () => {
    expect(isDeadSession(dead())).toBe(true);
    expect(isDeadSession(new Error('Orca x failed: [session_caller_not_live] gone'))).toBe(true);
    expect(isDeadSession(new OrcaRefused('x', 'agent_unconfigured'))).toBe(false);
    expect(isDeadSession(new Error('network timeout'))).toBe(false);
    expect(isDeadSession(new Error('Integration gate is red'))).toBe(false);
  });

  it('starts a fresh Lead through the handoff instead of failing every tick', async () => {
    const { dir, store } = fixture();
    const fresh: string[] = [];
    const supervisor = new MultiSupervisor(store, runtime(async () => { throw dead(); }), { freshLead: async (goalId, repoPath) => { fresh.push(`${goalId}@${repoPath}`); } });
    const actions: string[] = await (supervisor as unknown as { wakeLead(g: string, r: string, e: string[]): Promise<string[]> }).wakeLead(spec.id, dir, ['all packages verified: ready to integrate']);
    expect(fresh).toEqual([`${spec.id}@${dir}`]);
    expect(actions.join('\n')).toMatch(/fresh Lead/);
    store.close();
  });

  it('still raises the error when no fresh-Lead route is configured', async () => {
    const { dir, store } = fixture();
    const supervisor = new MultiSupervisor(store, runtime(async () => { throw dead(); }));
    await expect((supervisor as unknown as { wakeLead(g: string, r: string, e: string[]): Promise<string[]> }).wakeLead(spec.id, dir, ['x'])).rejects.toThrow(/session_caller_not_live/);
    store.close();
  });

  it('puts an error that repeats on consecutive ticks into the inbox once, and not on the first', async () => {
    const { dir, store } = fixture();
    const failing = { ...runtime(async () => { throw dead(); }), async checkRun() { throw new Error('Orca orchestration check failed: [session_caller_not_live] chat closed'); }, async ackRun() { return; }, async retainWorker() { return; } } as RuntimeAdapter & PackageRuntime;
    const controller = new ControllerService(store, failing);
    const notices = () => store.events(spec.id).filter(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'tick-error');
    await controller.tick(dir);
    expect(notices()).toHaveLength(0);
    await controller.tick(dir); await controller.tick(dir);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].data).toMatchObject({ error: expect.stringMatching(/session_caller_not_live/) });
    store.close();
  });

  it('treats errors that differ only in ids or numbers as the same error', async () => {
    const { dir, store } = fixture();
    let n = 0;
    const failing = { ...runtime(async () => { throw dead(); }), async checkRun() { throw new Error(`Orca check failed: request req_${++n}abcdef12 took ${n * 7} ms`); }, async ackRun() { return; }, async retainWorker() { return; } } as RuntimeAdapter & PackageRuntime;
    const controller = new ControllerService(store, failing);
    for (let i = 0; i < 4; i++) await controller.tick(dir);
    const events = store.events(spec.id);
    expect(events.filter(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'tick-error')).toHaveLength(1);
    expect(events.filter(item => item.type === 'decision-logged' && (item.data as { tickError?: string })?.tickError)).toHaveLength(1);
    store.close();
  });

  it('lead wake on an executing Goal explains that the controller wakes the Lead, not "still in its turn"', async () => {
    const { dir, store } = fixture(add => {
      add('proposal-drafted', proposal); add('proposal-approved'); add('dispatch-intended', 'k2');
      add('execution-started', { runId: 'run-1', taskId: 't', dispatchId: 'lead-1', owner: 'lead', repoPath: 'x' });
    });
    expect(store.getGoal(spec.id)?.status).toBe('executing');
    await expect(new LeadService(store, runtime(async () => { throw new Error('none'); })).wake(spec.id, dir, 'go')).rejects.toThrow(/controller/);
    store.close();
  });
});
