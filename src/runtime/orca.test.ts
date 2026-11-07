import { describe, expect, it } from 'vitest';
import { extractStartedRef, interpretWorkerShow, OrcaRuntime, parseOrcaResult } from './orca.js';

describe('Orca adapter result', () => {
  it('rejects an unknown or failed response rather than claiming a dispatch', () => {
    expect(() => parseOrcaResult('{"ok":false,"result":{}}')).toThrow();
    expect(() => parseOrcaResult('not json')).toThrow();
  });
});

it('registers an unmanaged project before starting its Solo Lead', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime((args) => {
    calls.push(args);
    if (args[0] === 'repo') return { repo: { id: 'repo_1' } };
    if (args[1] === 'run-create') return { run: { id: 'run_1' } };
    return { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', effects: [] };
  }, () => 'a'.repeat(40));
  const ref = await runtime.startSolo({ repoPath: 'C:/project', goalId: 'GOAL-001', proposalVersion: 1, idempotencyKey: 'key-1' });
  expect(calls[0]).toEqual(['repo', 'add', '--path', 'C:/project']);
  expect(ref.dispatchId).toBe('ctx_1');
});

it('starts a package Worker in a dedicated Orca worktree', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[0] === 'repo') return { repo: { id: 'repo_1' } };
    if (args[1] === 'run-list') return { runs: [] };
    if (args[1] === 'run-create') return { run: { id: 'run_1' } };
    return { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', effects: [] };
  }, () => 'a'.repeat(40));
  const ref = await runtime.startPackage({ repoPath: 'C:/project', idempotencyKey: 'key-1', package: {
    id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)'], acceptance: [{ id: 'WP-AC-1', text: 'scan' }], integration: 'Lead verifies'
  } });
  expect(calls[0]).toEqual(['repo', 'add', '--path', 'C:/project']);
  const start = calls.find(args => args[1] === 'worker-start')!;
  expect(start).toContain('new-top-level');
  expect(start).toContain('path:C:/project');
  expect(start).toContain('HEAD');
  expect(start.join(' ')).toContain('.apos/goals/GOAL-001/evidence/WP-01-v1.md');
  expect(ref.owner).toBe('worker');
});

it('shares one Orca Run across independent packages in a dispatch wave', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[0] === 'repo') return { repo: {} };
    if (args[1] === 'run-list') return { runs: [] };
    if (args[1] === 'run-create') return { run: { id: 'run_shared' } };
    return { runId: 'run_shared', taskId: 'task_1', dispatchId: `ctx_${calls.length}`, effects: [] };
  }, () => 'a'.repeat(40));
  const a = { id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)'], acceptance: [{ id: 'WP-AC-1', text: 'scan' }], integration: 'Lead verifies' };
  const refs = await Promise.all([runtime.startPackage({ package: a, repoPath: 'C:/project', idempotencyKey: 'key-1' }), runtime.startPackage({ package: { ...a, id: 'WP-02' }, repoPath: 'C:/project', idempotencyKey: 'key-2' })]);
  expect(calls.filter(args => args[1] === 'run-create')).toHaveLength(1);
  expect(refs.map(ref => ref.runId)).toEqual(['run_shared', 'run_shared']);
});

it('rebinds an existing Goal Run before dispatching its next package wave', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[0] === 'repo') return { repo: {} };
    if (args[1] === 'run-list') return { runs: [{ id: 'run_shared', objective: 'APOS package Run C:/project GOAL-001 goal v1' }] };
    if (args[1] === 'run-use') return { run: { id: 'run_shared' } };
    return { runId: 'run_shared', taskId: 'task_2', dispatchId: 'ctx_2', effects: [] };
  }, () => 'a'.repeat(40));
  await runtime.startPackage({ repoPath: 'C:/project', idempotencyKey: 'key-2', package: { id: 'WP-02', goalId: 'GOAL-001', goalVersion: 1, version: 1, owner: 'worker-b', outcome: 'History', scope: ['history'], exclusions: [], dependencies: [], interfaces: ['history()'], acceptance: [{ id: 'WP-AC-2', text: 'history' }], integration: 'Lead verifies' } });
  expect(calls.find(args => args[1] === 'run-use')).toEqual(['orchestration', 'run-use', '--id', 'run_shared']);
  expect(calls.some(args => args[1] === 'run-create')).toBe(false);
});

it('finds a package dispatch on an older Orca Run page', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[1] === 'run-list' && !args.includes('--cursor')) return { runs: [], nextCursor: 'older' };
    if (args[1] === 'run-list') return { runs: [{ id: 'run_1', objective: 'APOS GOAL-001 WP-01 v1 key lost-key' }] };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task_1', spec: 'Target: C:/project, GOAL-001, WP-01. APOS dispatch key: lost-key.' }] };
    return { dispatch: { id: 'ctx_1', assignee_handle: 'term_1' } };
  });
  expect(await runtime.recoverPackage('lost-key')).toMatchObject({ runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', owner: 'worker', terminal: 'term_1' });
  expect(calls[1]).toEqual(['orchestration', 'run-list', '--cursor', 'older']);
});

it('recovers a package from its shared Goal Run by the original dispatch key', async () => {
  const runtime = new OrcaRuntime(args => {
    if (args[1] === 'run-list') return { runs: [{ id: 'run_shared', objective: 'APOS package Run C:/project GOAL-001 goal v1' }] };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task_2', spec: `Target: C:/project, GOAL-001, WP-02. APOS dispatch key: key-2. APOS base commit: ${'a'.repeat(40)}.` }] };
    if (args[1] === 'dispatch-show') return { dispatch: { id: 'ctx_2', assignee_handle: 'term_2' } };
    return { worker: { worktreeId: 'repo_1::C:/worktree' } };
  });
  expect(await runtime.recoverPackage('key-2')).toMatchObject({ runId: 'run_shared', taskId: 'task_2', dispatchId: 'ctx_2', terminal: 'term_2', worktreeId: 'repo_1::C:/worktree', baseCommit: 'a'.repeat(40) });
});

it('resumes a revised package in its original terminal and worktree', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    return { runId: 'run_1', taskId: 'task_2', dispatchId: 'ctx_2', effects: [{ kind: 'worktree', id: 'repo_1::C:/worktree' }] };
  });
  const ref = await runtime.resumePackage({ package: {
    id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 2, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token, device)'], acceptance: [{ id: 'WP-AC-1', text: 'scan' }], integration: 'Lead verifies'
  }, prior: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', owner: 'worker', repoPath: 'C:/project', terminal: 'term_1', worktreeId: 'repo_1::C:/worktree' }, idempotencyKey: 'key-2' });
  const start = calls.find(args => args[1] === 'worker-start')!;
  expect(start).toContain('term_1');
  expect(start).toContain('id:repo_1::C:/worktree');
  expect(ref).toMatchObject({ owner: 'worker', dispatchId: 'ctx_2', worktreeId: 'repo_1::C:/worktree' });
});

it('recovers a phased Solo resume from its known Run without scanning for a new Run', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[1] === 'task-list') return { tasks: [{ id: 'task_2', spec: 'Target: C:/project, APOS Solo Goal. APOS dispatch key: resume-key.' }] };
    return { dispatch: { id: 'ctx_2', assignee_handle: 'term_1' } };
  });
  expect(await runtime.recover('resume-key', 'run_1')).toMatchObject({ runId: 'run_1', dispatchId: 'ctx_2', terminal: 'term_1' });
  expect(calls.some(args => args[1] === 'run-list')).toBe(false);
});

it('treats a live terminal with a settled dispatch as settled work', () => {
  const shown = { dispatch: { status: 'completed' }, observation: { status: 'live' }, projection: { liveness: { verdict: 'live' } } };
  expect(interpretWorkerShow(shown)).toBe('settled');
});

describe('Orca worker-start receipt', () => {
  it('uses the IDs and terminal effect returned by the installed CLI', () => {
    const receipt = {
      runId: 'run_b76bace6cd54', taskId: 'task_391c31c50c4b', dispatchId: 'ctx_cfc504ed2891',
      effects: [{ kind: 'terminal', role: 'agent', id: 'term_af3d8e8e-0991-411f-a74a-7f95a5ae2f5f' }]
    };
    expect(extractStartedRef(receipt, 'C:/project')).toEqual({
      runId: 'run_b76bace6cd54', taskId: 'task_391c31c50c4b', dispatchId: 'ctx_cfc504ed2891',
      owner: 'lead', repoPath: 'C:/project', terminal: 'term_af3d8e8e-0991-411f-a74a-7f95a5ae2f5f'
    });
  });
});

it('binds to the Goal Run and acknowledges the exact Orca Delivery', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[1] === 'run-use') return { run: { id: 'run_1' } };
    if (args.includes('--ack')) return { acknowledged: 'delivery_1', messages: [] };
    return { deliveryId: 'delivery_1', messages: [{ id: 'msg_1', type: 'status', body: 'ready' }] };
  });
  const delivery = await runtime.checkRun('run_1');
  expect(delivery).toEqual({ deliveryId: 'delivery_1', messages: [{ id: 'msg_1', type: 'status', body: 'ready' }] });
  await runtime.ackRun('run_1', delivery.deliveryId!);
  expect(calls.filter(args => args[1] === 'run-use')).toHaveLength(2);
  expect(calls.at(-1)).toEqual(['orchestration', 'check', '--run', 'run_1', '--ack', 'delivery_1']);
});

it('releases a terminal only after Orca reports a settled Dispatch', async () => {
  const calls: string[][] = [];
  let status = 'dispatched';
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[1] === 'worker-show') return { dispatch: { status } };
    return { releaseState: 'released' };
  });
  await expect(runtime.releaseWorker('ctx_1')).rejects.toThrow(/settle/);
  expect(calls.some(args => args[1] === 'worker-release')).toBe(false);
  status = 'completed';
  await runtime.releaseWorker('ctx_1');
  expect(calls.at(-1)).toEqual(['orchestration', 'worker-release', '--dispatch', 'ctx_1']);
});
