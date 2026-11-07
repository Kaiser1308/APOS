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
  });
  const ref = await runtime.startSolo({ repoPath: 'C:/project', goalId: 'GOAL-001', proposalVersion: 1, idempotencyKey: 'key-1' });
  expect(calls[0]).toEqual(['repo', 'add', '--path', 'C:/project']);
  expect(ref.dispatchId).toBe('ctx_1');
});

it('starts a package Worker in a dedicated Orca worktree', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[0] === 'repo') return { repo: { id: 'repo_1' } };
    if (args[1] === 'run-create') return { run: { id: 'run_1' } };
    return { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', effects: [] };
  });
  const ref = await runtime.startPackage({ repoPath: 'C:/project', idempotencyKey: 'key-1', package: {
    id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)'], acceptance: [{ id: 'WP-AC-1', text: 'scan' }], integration: 'Lead verifies'
  } });
  expect(calls[0]).toEqual(['repo', 'add', '--path', 'C:/project']);
  expect(calls[2]).toContain('new-top-level');
  expect(calls[2]).toContain('path:C:/project');
  expect(calls[2]).toContain('HEAD');
  expect(ref.owner).toBe('worker');
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

it('resumes a revised package in its original terminal and worktree', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    return { runId: 'run_1', taskId: 'task_2', dispatchId: 'ctx_2', effects: [{ kind: 'worktree', id: 'repo_1::C:/worktree' }] };
  });
  const ref = await runtime.resumePackage({ package: {
    id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 2, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token, device)'], acceptance: [{ id: 'WP-AC-1', text: 'scan' }], integration: 'Lead verifies'
  }, prior: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', owner: 'worker', repoPath: 'C:/project', terminal: 'term_1', worktreeId: 'repo_1::C:/worktree' }, idempotencyKey: 'key-2' });
  expect(calls[0]).toContain('term_1');
  expect(calls[0]).toContain('id:repo_1::C:/worktree');
  expect(ref).toMatchObject({ owner: 'worker', dispatchId: 'ctx_2', worktreeId: 'repo_1::C:/worktree' });
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
