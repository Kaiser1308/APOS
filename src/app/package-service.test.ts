import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, approval, gateReport } from '../domain/fixtures.test-support.js';
import { PackageService } from './package-service.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import { ReviewService } from './review.js';
import type { PackageRuntime } from '../ports/runtime.js';
import { applyEvent } from '../domain/transitions.js';
import { attemptKey } from '../domain/gate.js';
import { UserError } from '../domain/errors.js';
import { coordinationNotices } from './multi-lead-gate.js';
import { GateService } from './gate-service.js';

const a: WorkPackageSpec = {
  id: 'WP-01',
  goalId: 'GOAL-001',
  goalVersion: 1,
  version: 1,
  owner: 'worker-a',
  outcome: 'QR scanner works',
  scope: ['scanner'],
  exclusions: [],
  dependencies: [],
  interfaces: ['checkIn(token) -> result@v1'],
  acceptance: [{ id: 'WP-AC-1', text: 'scans valid QR', goalAcceptanceId: 'AC-1' }],
  integration: 'Lead verifies check-in',
};
const b: WorkPackageSpec = {
  ...a,
  id: 'WP-02',
  owner: 'worker-b',
  outcome: 'History works',
  acceptance: [{ id: 'WP-AC-2', text: 'persists history' }],
  dependencies: ['WP-01'],
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = (risks: string[] = [], maxAttempts = 3) => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-packages-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  for (const [type, data] of [
    ['goal-drafted', spec],
    ['goal-approved', { appetite: { ...approval.appetite, maxAttempts } }],
    ['goal-selected', undefined],
    ['proposal-drafted', { ...proposal, mode: 'multi-wp', risks }],
  ] as const)
    store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  return { store, dir };
};
const approve = (store: SqliteStore) =>
  store.append({
    id: `EV-approve-${Math.random()}`,
    goalId: spec.id,
    type: 'proposal-approved',
    at: '2026-11-07T00:00:00.000Z',
  });
class FakeRuntime implements PackageRuntime {
  starts: string[] = [];
  resumes: string[] = [];
  inspectState: 'completed' | 'failed' | 'live' | 'unverifiable' = 'completed';
  recovered = new Map<string, Awaited<ReturnType<PackageRuntime['startPackage']>>>();
  deps = new Map<string, string[] | undefined>();
  resumedDeps = new Map<string, string[] | undefined>();
  async startPackage(input: { package: WorkPackageSpec; repoPath: string; dependencyCommits?: string[] }) {
    this.starts.push(input.package.id);
    this.deps.set(input.package.id, input.dependencyCommits);
    return {
      runId: 'run_1',
      taskId: `task_${input.package.id}`,
      dispatchId: `ctx_${input.package.id}`,
      owner: 'worker' as const,
      repoPath: input.repoPath,
      baseCommit: 'b'.repeat(40),
    };
  }
  async recoverPackage(key: string) {
    return this.recovered.get(key);
  }
  async inspectPackage() {
    return this.inspectState;
  }
  async resumePackage(input: {
    package: WorkPackageSpec;
    prior: Awaited<ReturnType<PackageRuntime['startPackage']>>;
    dependencyCommits?: string[];
  }) {
    this.resumes.push(input.package.id);
    this.resumedDeps.set(input.package.id, input.dependencyCommits);
    return { ...input.prior, dispatchId: `ctx-resumed-${input.package.id}-${this.resumes.length}` };
  }
}

describe('package scheduling', () => {
  it('lets Lead draft packages before approval but refuses dispatch', async () => {
    const { store } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, b);
    await expect(service.dispatchReady(spec.id, 'C:/project')).rejects.toThrow(/Approved Multi-WP Goal required/);
    store.close();
  });
  it('dispatches only the dependency-ready package and does not duplicate it', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    expect(service.ready(spec.id).map(item => item.id)).toEqual(['WP-01']);
    await service.dispatchReady(spec.id, dir);
    await service.dispatchReady(spec.id, dir);
    expect(runtime.starts).toEqual(['WP-01']);
    expect(service.ready(spec.id)).toEqual([]);
    store.close();
  });
  it('dispatches independent packages in one wave', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    expect(service.ready(spec.id).map(item => item.id)).toEqual(['WP-01', 'WP-02']);
    await service.dispatchReady(spec.id, dir);
    expect(runtime.starts).toEqual(['WP-01', 'WP-02']);
    store.close();
  });
  it('keeps dependents blocked until the prerequisite is verified', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    expect(service.ready(spec.id)).toEqual([]);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:test',
      commitRef: 'abc123',
    });
    await service.verify(spec.id, a.id);
    expect(service.ready(spec.id)).toEqual([]);
    service.holdDispatch(spec.id, b.id, 'Wait for review');
    expect(service.ready(spec.id)).toEqual([]);
    service.setApprovalPolicy(spec.id, false, 'No further review needed');
    expect(service.ready(spec.id).map(item => item.id)).toEqual([b.id]);
    service.setApprovalPolicy(spec.id, true, 'Require review again');
    expect(service.ready(spec.id)).toEqual([]);
    service.approveDispatch(spec.id, b.id, 'The prerequisite is ready');
    expect(service.ready(spec.id).map(item => item.id)).toEqual(['WP-02']);
    store.close();
  });
  it('preserves verified packages when the Lead adds and removes settled work', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'test',
      artifactRef: 'log',
      commitRef: 'abc',
    });
    await service.verify(spec.id, a.id);
    const extra = { ...b, id: 'WP-03', dependencies: ['WP-01'] };
    service.add(spec.id, extra, 'Split remaining work');
    expect(() => service.remove(spec.id, a.id, 'Remove verified')).toThrow(/unverified/);
    service.approveDispatch(spec.id, b.id, 'Ready to run');
    await service.dispatchReady(spec.id, dir);
    const dispatchId = store.getGoal(spec.id)!.packages![b.id].runtimeRef!.dispatchId;
    expect(() => service.remove(spec.id, b.id, 'Still running')).toThrow(/settlement/);
    store.append({
      id: 'settled-b',
      goalId: spec.id,
      type: 'worker-settled',
      data: { dispatchId, outcome: 'failed' },
      at: '2026-11-07T00:01:00.000Z',
    });
    service.remove(spec.id, b.id, 'Replace failed work');
    expect(store.getGoal(spec.id)?.packages?.[a.id].status).toBe('verified');
    expect(store.getGoal(spec.id)?.packages?.[b.id]).toBeUndefined();
    expect(
      store
        .events(spec.id)
        .filter(event => ['package-plan-added', 'package-removed'].includes(event.type))
        .map(event => (event.data as { reason: string }).reason),
    ).toEqual(['Split remaining work', 'Replace failed work']);
    store.close();
  });
  it('refuses to change the plan while a Goal review start or reviewer is pending', () => {
    const { store } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    const state = store.getGoal(spec.id)!;
    const pending = {
      ...state,
      status: 'executing' as const,
      leadApprovalRequired: true,
      reviewIntent: { key: 'review-key', commit: 'c'.repeat(40), at: '2026-11-07T00:00:00.000Z' },
    };
    const event = (type: 'package-plan-added' | 'package-removed' | 'package-revised', data: unknown) => ({
      id: `review-${type}`,
      goalId: spec.id,
      type,
      data,
      at: '2026-11-07T00:00:00.000Z',
    });
    expect(() =>
      applyEvent(pending, event('package-plan-added', { spec: { ...b, id: 'WP-03' }, reason: 'Add' })),
    ).toThrow(/review.*pending/i);
    expect(() => applyEvent(pending, event('package-removed', { packageId: b.id, reason: 'Remove' }))).toThrow(
      /review.*pending/i,
    );
    expect(() =>
      applyEvent(pending, event('package-revised', { spec: { ...b, version: 2 }, reason: 'Revise' })),
    ).toThrow(/review.*pending/i);
    const running = {
      ...pending,
      reviewIntent: undefined,
      reviewDispatch: { dispatchId: 'reviewer', runId: 'run', key: 'key', commit: 'c'.repeat(40) },
    };
    expect(() =>
      applyEvent(running, event('package-plan-added', { spec: { ...b, id: 'WP-03' }, reason: 'Add' })),
    ).toThrow(/review.*pending/i);
    expect(() => applyEvent(running, event('package-removed', { packageId: b.id, reason: 'Remove' }))).toThrow(
      /review.*pending/i,
    );
    expect(() =>
      applyEvent(running, event('package-revised', { spec: { ...b, version: 2 }, reason: 'Revise' })),
    ).toThrow(/review.*pending/i);
    store.close();
  });
  it('keeps a pending Goal review collectable when the Lead tries to change the plan after the gate', async () => {
    const { store, dir } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    const independent = { ...b, dependencies: [] };
    service.add(spec.id, a);
    service.add(spec.id, independent);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    for (const [item, commitRef] of [
      [a, 'a'.repeat(40)],
      [independent, 'b'.repeat(40)],
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
    store.append({
      id: 'goal-gate',
      goalId: spec.id,
      type: 'gate-recorded',
      data: { ...gateReport(delivery), attemptKey: attemptKey(store.getGoal(spec.id)!) },
      at: '2026-11-07T00:02:00.000Z',
    });
    store.append({
      id: 'goal-review-intent',
      goalId: spec.id,
      type: 'review-intended',
      data: { key: 'goal-review', commit: delivery },
      at: '2026-11-07T00:03:00.000Z',
    });
    expect(() => service.add(spec.id, { ...b, id: 'WP-03', dependencies: [] }, 'Add late work')).toThrow(
      /review pending/i,
    );
    expect(() => service.revise(spec.id, { ...independent, version: 2 }, 'Revise during review')).toThrow(
      /review pending/i,
    );
    expect(() => service.remove(spec.id, independent.id, 'Remove during review')).toThrow(/review pending/i);
    const state = store.getGoal(spec.id)!;
    expect(state.gate?.deliveryCommit).toBe(delivery);
    expect(state.reviewIntent?.key).toBe('goal-review');
    expect(Object.values(state.packages!).map(item => item.status)).toEqual(['verified', 'verified']);
    store.close();
  });
  it('stops new work at wall time until the Human raises the appetite', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime, () => Date.parse('2026-11-07T05:00:00.000Z'));
    store.append({
      id: 'lead-intent',
      goalId: spec.id,
      type: 'lead-dispatch-intended',
      data: 'lead-key',
      at: '2026-11-07T00:00:00.000Z',
    });
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    expect(await service.dispatchReady(spec.id, dir)).toEqual([]);
    expect(await service.dispatchReady(spec.id, dir)).toEqual([]);
    expect(store.events(spec.id).filter(event => event.type === 'multi-time-exhausted')).toHaveLength(1);
    expect(store.events(spec.id).some(event => event.type === 'human-notified')).toBe(true);
    store.append({
      id: 'extend-time',
      goalId: spec.id,
      type: 'appetite-set',
      data: { appetite: { ...approval.appetite, maxWallMinutes: 600 }, reason: 'Allow more time' },
      at: '2026-11-07T05:01:00.000Z',
    });
    await service.dispatchReady(spec.id, dir);
    expect(runtime.starts).toEqual([a.id]);
    store.close();
  });
  it('routes an exhausted failure to the Lead and resets attempts for a revised version', async () => {
    const { store, dir } = fixture([], 1);
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    const ref = store.getGoal(spec.id)!.packages![a.id].runtimeRef!;
    store.append({
      id: 'settled-a',
      goalId: spec.id,
      type: 'worker-settled',
      data: { dispatchId: ref.dispatchId, outcome: 'completed' },
      at: '2026-11-07T00:01:00.000Z',
    });
    store.append({
      id: 'red-a',
      goalId: spec.id,
      type: 'package-gate-recorded',
      data: {
        packageId: a.id,
        report: { ...gateReport(undefined, 'red'), attemptKey: 'WP-01@1:1' },
        signature: 'same-failure',
      },
      at: '2026-11-07T00:02:00.000Z',
    });
    expect(store.getGoal(spec.id)?.packages?.[a.id].leadDecisionRequired).toBe(true);
    await expect(service.resumeStale(spec.id, a.id)).rejects.toThrow(/Lead decision/);
    expect(() => service.decideFailure(spec.id, a.id, 'retry', 'Try again')).toThrow(/Human decision/);
    service.decideFailure(spec.id, a.id, 'escalate', 'Needs more attempts');
    expect(store.events(spec.id).some(event => event.type === 'human-notified')).toBe(true);
    service.revise(spec.id, { ...a, version: 2, scope: ['updated implementation'] }, 'Change approach');
    expect(store.getGoal(spec.id)?.packages?.[a.id].attempts).toBe(0);
    await service.resumeStale(spec.id, a.id);
    expect(store.getGoal(spec.id)?.packages?.[a.id].attempts).toBe(1);
    store.close();
  });
  it('routes three identical failures and an unverifiable gate to the Lead before the Human', async () => {
    for (const result of ['red', 'unverifiable'] as const) {
      const { store, dir } = fixture([], 5);
      const service = new PackageService(store, new FakeRuntime());
      service.add(spec.id, a);
      service.add(spec.id, b);
      approve(store);
      await service.dispatchReady(spec.id, dir);
      const count = result === 'red' ? 3 : 1;
      for (let n = 1; n <= count; n++) {
        const ref = store.getGoal(spec.id)!.packages![a.id].runtimeRef!;
        store.append({
          id: `settled-${n}`,
          goalId: spec.id,
          type: 'worker-settled',
          data: { dispatchId: ref.dispatchId, outcome: 'completed' },
          at: '2026-11-07T00:01:00.000Z',
        });
        store.append({
          id: `gate-${n}`,
          goalId: spec.id,
          type: 'package-gate-recorded',
          data: {
            packageId: a.id,
            report: { ...gateReport(undefined, result), attemptKey: `WP-01@1:${n}` },
            signature: 'same',
          },
          at: '2026-11-07T00:02:00.000Z',
        });
        if (n < count) await service.resumeStale(spec.id, a.id);
      }
      expect(store.getGoal(spec.id)?.packages?.[a.id].leadDecisionRequired).toBe(true);
      expect(store.events(spec.id).some(event => event.type === 'human-notified')).toBe(false);
      await expect(service.resumeStale(spec.id, a.id)).rejects.toBeInstanceOf(UserError);
      await expect(service.resumeStale(spec.id, a.id)).rejects.toThrow(/Lead decision/);
      const firstNotice = coordinationNotices(store.getGoal(spec.id)!).filter(item => item.includes('needs Lead'));
      service.decideFailure(spec.id, a.id, 'retry', 'A different repair is available');
      await service.resumeStale(spec.id, a.id);
      expect(store.events(spec.id).some(event => event.type === 'package-failure-decided')).toBe(true);
      // The authorized retry fails the same way: its decision request must not repeat a notice the Lead was already woken for.
      const retried = store.getGoal(spec.id)!.packages![a.id];
      store.append({
        id: 'settled-retry',
        goalId: spec.id,
        type: 'worker-settled',
        data: { dispatchId: retried.runtimeRef!.dispatchId, outcome: 'completed' },
        at: '2026-11-07T00:03:00.000Z',
      });
      store.append({
        id: 'gate-retry',
        goalId: spec.id,
        type: 'package-gate-recorded',
        data: {
          packageId: a.id,
          report: { ...gateReport(undefined, 'unverifiable'), attemptKey: `WP-01@1:${retried.attempts}` },
          signature: 'same',
        },
        at: '2026-11-07T00:04:00.000Z',
      });
      expect(store.getGoal(spec.id)?.packages?.[a.id].leadDecisionRequired).toBe(true);
      const secondNotice = coordinationNotices(store.getGoal(spec.id)!).filter(item => item.includes('needs Lead'));
      expect(secondNotice).toHaveLength(1);
      expect(firstNotice).not.toContain(secondNotice[0]);
      store.close();
    }
  });
  it('starts a dependent package from its verified dependency commits (seen live: it started without them)', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:test',
      commitRef: 'abc123',
    });
    await service.verify(spec.id, a.id);
    service.approveDispatch(spec.id, b.id, 'Dependency verified');
    await service.dispatchReady(spec.id, dir);
    expect(runtime.deps.get('WP-01')).toEqual([]);
    expect(runtime.deps.get('WP-02')).toEqual(['abc123']);
    store.close();
  });
  it('rejects a package head that lacks its verified dependency', async () => {
    const { store, dir } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, { ...b, acceptance: [{ ...b.acceptance[0], checkIds: ['CHK-1'] }] });
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'test',
      artifactRef: 'log',
      commitRef: 'a'.repeat(40),
    });
    await service.verify(spec.id, a.id);
    service.approveDispatch(spec.id, b.id, 'Dependency reviewed');
    await service.dispatchReady(spec.id, dir);
    const gate = new GateService(store, {
      artifactRoot: dir,
      inspector: { exists: () => true, files: () => [], contains: (_repo, ancestor) => ancestor === 'b'.repeat(40) },
      workspaces: { checkout: () => ({ path: dir, dispose: () => undefined }) },
      executor: { shell: 'test', run: () => ({ exitCode: 0, timedOut: false, output: '' }) },
    });
    const report = gate.runPackage(spec.id, b.id, dir, 'c'.repeat(40));
    expect(report.result).toBe('red');
    expect(report.checks).toContainEqual(expect.objectContaining({ checkId: 'APOS-DEPENDENCIES', status: 'fail' }));
    store.close();
  });
  it('requires current-owner passing evidence for every local criterion', async () => {
    const { store, dir } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    await service.dispatchReady(spec.id, dir);
    const evidence = {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass' as const,
      command: 'npm test',
      artifactRef: 'log:test',
      commitRef: 'abc123',
    };
    expect(() => service.submitEvidence(spec.id, { ...evidence, owner: 'wrong-owner' })).toThrow(/owner/i);
    expect(() => service.submitEvidence(spec.id, { ...evidence, packageVersion: 2 })).toThrow(/version/i);
    await expect(service.verify(spec.id, a.id)).rejects.toThrow(/evidence/i);
    service.submitEvidence(spec.id, { ...evidence, result: 'fail' });
    await expect(service.verify(spec.id, a.id)).rejects.toThrow(/evidence/i);
    service.submitEvidence(spec.id, evidence);
    await service.verify(spec.id, a.id);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('verified');
    store.close();
  });
  it('does not verify a package while its Orca Worker is still live', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    runtime.inspectState = 'live';
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:a',
      commitRef: 'abc123',
    });
    await expect(service.verify(spec.id, a.id)).rejects.toThrow(/Orca Worker must complete/);
    expect(service.ready(spec.id)).toEqual([]);
    store.close();
  });
  it('requires a different reviewer for a risky package before releasing dependents', async () => {
    const { store, dir } = fixture(['Auth regression']);
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:a',
      commitRef: 'commit-a',
    });
    await expect(service.verify(spec.id, a.id)).rejects.toThrow(/independent package review/i);
    const reviews = new ReviewService(store);
    expect(() =>
      reviews.submit(spec.id, {
        subject: 'package',
        packageId: a.id,
        packageVersion: 1,
        reviewer: a.owner,
        session: 'self',
        result: 'pass',
        commitRef: 'commit-a',
        note: 'Self review',
      }),
    ).toThrow(/Reviewer must differ/);
    reviews.submit(spec.id, {
      subject: 'package',
      packageId: a.id,
      packageVersion: 1,
      reviewer: 'reviewer-agent',
      session: 'review-reviewer-agent',
      result: 'pass',
      commitRef: 'commit-a',
      note: 'Checked diff and tests',
    });
    await service.verify(spec.id, a.id);
    service.approveDispatch(spec.id, b.id, 'Review accepted');
    expect(service.ready(spec.id).map(item => item.id)).toEqual([b.id]);
    store.close();
  });
  it('parks a package when its approved attempt budget is exhausted', async () => {
    const { store, dir } = fixture([], 1);
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'fail',
      command: 'npm test',
      artifactRef: 'log:a',
      commitRef: 'commit-a',
    });
    new ReviewService(store).submit(spec.id, {
      subject: 'package',
      packageId: a.id,
      packageVersion: 1,
      reviewer: 'reviewer-agent',
      session: 'review-reviewer-agent',
      result: 'changes',
      commitRef: 'commit-a',
      note: 'Fix validation',
    });
    await expect(service.resumeStale(spec.id, a.id)).rejects.toThrow(/budget exhausted/);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('blocked');
    expect(runtime.resumes).toEqual([]);
    store.close();
  });
  it('invalidates verified downstream evidence when an upstream contract changes', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:a',
      commitRef: 'abc123',
    });
    await service.verify(spec.id, a.id);
    service.approveDispatch(spec.id, b.id, 'Dependency verified');
    await service.dispatchReady(spec.id, dir);
    service.submitEvidence(spec.id, {
      packageId: b.id,
      packageVersion: 1,
      owner: b.owner,
      acceptanceId: 'WP-AC-2',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:b',
      commitRef: 'def456',
    });
    await service.verify(spec.id, b.id);
    service.revise(
      spec.id,
      { ...a, version: 2, interfaces: ['checkIn(token, device) -> result@v1'] },
      'Contract now includes device',
    );
    const packages = store.getGoal(spec.id)?.packages;
    expect(packages?.[a.id]?.status).toBe('stale');
    expect(packages?.[b.id]?.status).toBe('stale');
    expect(packages?.[a.id]?.evidence).toEqual([]);
    expect(packages?.[b.id]?.evidence).toEqual([]);
    await expect(service.verify(spec.id, b.id)).rejects.toThrow();
    await service.resumeStale(spec.id, a.id);
    expect(runtime.resumes).toEqual(['WP-01']);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('executing');
    await expect(service.resumeStale(spec.id, b.id)).rejects.toThrow(/dependencies/i);
    service.submitEvidence(spec.id, {
      packageId: a.id,
      packageVersion: 2,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'test',
      artifactRef: 'log:a2',
      commitRef: 'new-dependency',
    });
    await service.verify(spec.id, a.id);
    service.approveDispatch(spec.id, b.id, 'Updated dependency reviewed');
    await service.resumeStale(spec.id, b.id);
    expect(runtime.resumedDeps.get(b.id)).toEqual(['new-dependency']);
    store.close();
  });
  it('allows package scope changes but protects Goal acceptance mapping and owner', () => {
    const { store } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, b);
    approve(store);
    service.revise(spec.id, { ...a, version: 2, scope: ['new implementation area'] }, 'Change implementation scope');
    expect(() =>
      service.revise(
        spec.id,
        { ...a, version: 3, acceptance: [{ ...a.acceptance[0], goalAcceptanceId: undefined }] },
        'Remove mapping',
      ),
    ).toThrow(/acceptance mapping/i);
    expect(() => service.revise(spec.id, { ...a, version: 3, owner: 'another-worker' }, 'Change owner')).toThrow(
      /owner/i,
    );
    store.close();
  });
  it('parks an external blocker and resumes the same owner after a recorded resolution', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.recordBlocker(spec.id, a.id, 'external', 'Device service unavailable');
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('blocked');
    service.unblock(spec.id, a.id, 'Device service restored');
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.status).toBe('stale');
    await service.resumeStale(spec.id, a.id);
    expect(runtime.resumes).toEqual(['WP-01']);
    store.close();
  });
  it('keeps a product blocker parked for Goal reapproval', async () => {
    const { store, dir } = fixture();
    const service = new PackageService(store, new FakeRuntime());
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.recordBlocker(spec.id, a.id, 'product', 'New flow required');
    expect(() => service.unblock(spec.id, a.id, 'Proceed')).toThrow(/Goal reapproval/i);
    store.close();
  });
  it('recovers a lost resume response without creating another dispatch', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    await service.dispatchReady(spec.id, dir);
    service.recordBlocker(spec.id, a.id, 'external', 'Offline');
    service.unblock(spec.id, a.id, 'Online');
    store.append({
      id: 'EV-resume-intent',
      goalId: spec.id,
      type: 'package-resume-intended',
      data: { packageId: a.id, key: 'resume-lost' },
      at: '2026-11-07T00:00:00.000Z',
    });
    runtime.recovered.set('resume-lost', {
      runId: 'run_1',
      taskId: 'task_2',
      dispatchId: 'ctx_2',
      owner: 'worker',
      repoPath: dir,
    });
    expect(await service.reconcile(spec.id)).toEqual([{ packageId: a.id, state: 'recovered' }]);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.runtimeRef).toMatchObject({ dispatchId: 'ctx_2' });
    expect(runtime.resumes).toEqual([]);
    store.close();
  });
  it('recovers an unknown dispatch instead of starting a second worker', async () => {
    const { store, dir } = fixture();
    const runtime = new FakeRuntime();
    const service = new PackageService(store, runtime);
    service.add(spec.id, a);
    service.add(spec.id, { ...b, dependencies: [] });
    approve(store);
    store.append({
      id: 'EV-intent',
      goalId: spec.id,
      type: 'package-dispatch-intended',
      data: { packageId: a.id, key: 'key-lost' },
      at: '2026-11-07T00:00:00.000Z',
    });
    runtime.recovered.set('key-lost', {
      runId: 'run-recovered',
      taskId: 'task-recovered',
      dispatchId: 'ctx-recovered',
      owner: 'worker',
      repoPath: dir,
    });
    await service.reconcile(spec.id);
    expect(store.getGoal(spec.id)?.packages?.[a.id]?.runtimeRef).toMatchObject({ dispatchId: 'ctx-recovered' });
    await service.dispatchReady(spec.id, dir);
    expect(runtime.starts).toEqual(['WP-02']);
    store.close();
  });
});
