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
