import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, gateReport, approval } from '../domain/fixtures.test-support.js';
import { SoloService } from './solo.js';
import { attemptKey } from '../domain/gate.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { RuntimeAdapter } from '../ports/runtime.js';
import type { RuntimeRef } from '../domain/runtime-refs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-solo-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let seq = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    store.append({ id: `EV-${++seq}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec);
  return { store, add, dir };
};
const ref: RuntimeRef = {
  runId: 'run_1',
  taskId: 'task_1',
  dispatchId: 'dispatch_1',
  owner: 'lead',
  repoPath: 'C:/project',
  terminal: 'term_lead',
  worktreeId: 'repo::C:/wt',
  baseCommit: 'b'.repeat(40),
};
class FakeRuntime implements RuntimeAdapter {
  starts = 0;
  resumes = 0;
  state: 'live' | 'settled' = 'live';
  outcome?: 'completed' | 'failed';
  failResume = false;
  recovered?: RuntimeRef;
  async startLead(): Promise<RuntimeRef> {
    this.starts++;
    return ref;
  }
  async resumeSolo(): Promise<RuntimeRef> {
    this.resumes++;
    if (this.failResume) throw new Error('Orca response lost');
    return ref;
  }
  async recover() {
    return this.recovered;
  }
  async inspect() {
    return { state: this.state, outcome: this.outcome, ref };
  }
}

describe('Solo dispatch', () => {
  it('refuses to record an owner before Goal selection and plan acceptance', async () => {
    const { store, add } = fixture();
    add('goal-approved', approval);
    await expect(new SoloService(store, new FakeRuntime()).adopt(spec.id)).rejects.toThrow();
    store.close();
  });
  it('makes the planning Lead the owner, once, with no new dispatch, across repeated calls and reopen', async () => {
    const { store, add, dir } = fixture();
    add('goal-approved', approval);
    add('goal-selected');
    add('lead-dispatch-intended', 'lead-key');
    add('lead-started', ref);
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const runtime = new FakeRuntime();
    const service = new SoloService(store, runtime);
    expect(await service.adopt(spec.id)).toMatchObject({
      dispatchId: ref.dispatchId,
      terminal: 'term_lead',
      worktreeId: 'repo::C:/wt',
      baseCommit: ref.baseCommit,
    });
    expect(await service.adopt(spec.id)).toMatchObject({ dispatchId: ref.dispatchId });
    store.close();
    const reopened = SqliteStore.open(join(dir, 'state.sqlite'));
    expect(await new SoloService(reopened, runtime).adopt(spec.id)).toMatchObject({ dispatchId: ref.dispatchId });
    expect(reopened.events(spec.id).filter(item => item.type === 'execution-started')).toHaveLength(1);
    expect(runtime.starts).toBe(0);
    reopened.close();
  });
  it('never gives an accepted Solo plan a cold owner when no APOS Lead runs it (plan accepted under the old flow)', async () => {
    const { store, add } = fixture();
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    await expect(new SoloService(store, new FakeRuntime()).adopt(spec.id)).rejects.toThrow(/apos lead start/);
    expect(store.getGoal(spec.id)?.status).toBe('ready');
    store.close();
  });
  it('resumes phased work with the prior owner and checkpoint', async () => {
    const { store, add } = fixture();
    add('goal-approved', approval);
    add('goal-selected');
    add('lead-dispatch-intended', 'lead-key');
    add('lead-started', ref);
    add('proposal-drafted', { ...proposal, mode: 'solo-phased' });
    add('proposal-approved');
    const runtime = new FakeRuntime();
    const service = new SoloService(store, runtime);
    await service.adopt(spec.id);
    add('checkpointed', { phase: 'phase-1', progress: 'done', evidenceRefs: ['commit:abc'] });
    runtime.state = 'settled';
    runtime.outcome = 'completed';
    await service.resume(spec.id);
    expect(runtime.resumes).toBe(1);
    expect(store.getGoal(spec.id)?.runtimeRef).toEqual(ref);
    store.close();
  });
  it('does not reuse a live terminal for phased resume', async () => {
    const { store, add } = fixture();
    add('goal-approved', approval);
    add('goal-selected');
    add('lead-dispatch-intended', 'lead-key');
    add('lead-started', ref);
    add('proposal-drafted', { ...proposal, mode: 'solo-phased' });
    add('proposal-approved');
    const runtime = new FakeRuntime();
    const service = new SoloService(store, runtime);
    await service.adopt(spec.id);
    add('checkpointed', { phase: 'phase-1', progress: 'done', evidenceRefs: [] });
    await expect(service.resume(spec.id)).rejects.toThrow(/settle/);
    expect(runtime.resumes).toBe(0);
    store.close();
  });
  it('does not verify Solo evidence until Orca reports successful completion', async () => {
    const { store, add } = fixture();
    add('goal-approved', approval);
    add('goal-selected');
    add('lead-dispatch-intended', 'lead-key');
    add('lead-started', ref);
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const runtime = new FakeRuntime();
    const service = new SoloService(store, runtime);
    await service.adopt(spec.id);
    add('evidence-submitted', { acceptanceId: 'AC-1', result: 'pass', command: 'npm test', artifactRef: 'log:test' });
    await expect(service.verify(spec.id)).rejects.toThrow(/complete successfully/);
    runtime.state = 'settled';
    runtime.outcome = 'failed';
    await expect(service.verify(spec.id)).rejects.toThrow(/complete successfully/);
    runtime.outcome = 'completed';
    await expect(service.verify(spec.id)).rejects.toThrow(/no controller gate/);
    add('gate-recorded', { ...gateReport(), attemptKey: attemptKey(store.getGoal(spec.id)!) });
    expect((await service.verify(spec.id)).passed).toBe(true);
    store.close();
  });
  it('recovers a lost phased resume response without starting another attempt', async () => {
    const { store, add } = fixture();
    add('goal-approved', approval);
    add('goal-selected');
    add('lead-dispatch-intended', 'lead-key');
    add('lead-started', ref);
    add('proposal-drafted', { ...proposal, mode: 'solo-phased' });
    add('proposal-approved');
    const runtime = new FakeRuntime();
    const service = new SoloService(store, runtime);
    await service.adopt(spec.id);
    add('checkpointed', { phase: 'phase-1', progress: 'done', evidenceRefs: [] });
    runtime.state = 'settled';
    runtime.outcome = 'completed';
    runtime.failResume = true;
    await expect(service.resume(spec.id)).rejects.toThrow(/response lost/);
    expect(store.getGoal(spec.id)?.resumeIntent).toBeTruthy();
    runtime.recovered = { ...ref, dispatchId: 'dispatch-recovered' };
    expect((await service.resume(spec.id)).dispatchId).toBe('dispatch-recovered');
    expect(runtime.resumes).toBe(1);
    store.close();
  });
  it('reuses a failed Solo Direct owner and invalidates prior evidence for the repair attempt', async () => {
    const { store, add } = fixture();
    add('goal-approved', approval);
    add('goal-selected');
    add('lead-dispatch-intended', 'lead-key');
    add('lead-started', ref);
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const runtime = new FakeRuntime();
    const service = new SoloService(store, runtime);
    await service.adopt(spec.id);
    add('evidence-submitted', { acceptanceId: 'AC-1', result: 'pass', command: 'npm test', artifactRef: 'old-log' });
    add('checkpointed', { phase: 'repair', progress: 'Fix failed QR edge case', evidenceRefs: [] });
    runtime.state = 'settled';
    runtime.outcome = 'failed';
    await service.resume(spec.id);
    expect(runtime.resumes).toBe(1);
    expect(store.getGoal(spec.id)?.evidence).toEqual([]);
    store.close();
  });
  it('parks Solo after its approved attempt budget is exhausted', async () => {
    const { store, add } = fixture();
    add('goal-approved', { appetite: { ...approval.appetite, maxAttempts: 1 } });
    add('goal-selected');
    add('lead-dispatch-intended', 'lead-key');
    add('lead-started', ref);
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const runtime = new FakeRuntime();
    const service = new SoloService(store, runtime);
    await service.adopt(spec.id);
    add('checkpointed', { phase: 'repair', progress: 'Retry needed', evidenceRefs: [] });
    runtime.state = 'settled';
    runtime.outcome = 'failed';
    await expect(service.resume(spec.id)).rejects.toThrow(/budget exhausted/);
    expect(store.getGoal(spec.id)?.status).toBe('blocked');
    expect(runtime.resumes).toBe(0);
    store.close();
  });
});
