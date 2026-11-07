import { describe, expect, it } from 'vitest';
import { extractStartedRef, interpretWorkerShow, parseOrcaResult } from './orca.js';

describe('Orca adapter result', () => {
  it('rejects an unknown or failed response rather than claiming a dispatch', () => {
    expect(() => parseOrcaResult('{"ok":false,"result":{}}')).toThrow();
    expect(() => parseOrcaResult('not json')).toThrow();
  });
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
