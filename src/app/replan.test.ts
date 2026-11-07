import { expect, it } from 'vitest';
import { applyEvent, type GoalEvent, type GoalEventType } from '../domain/transitions.js';
import { spec, proposal } from '../domain/fixtures.test-support.js';
import { assertExecutionSettled } from './replan.js';
import type { RuntimeAdapter } from '../runtime/orca.js';

it('blocks product replanning while Solo ownership is still live, then resets state for approval', async () => {
  let n = 0;
  const event = (type: GoalEventType, data?: unknown): GoalEvent => ({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-08T00:00:00.000Z' });
  let state = applyEvent(undefined, event('goal-drafted', spec));
  for (const type of ['goal-approved', 'goal-selected'] as const) state = applyEvent(state, event(type));
  state = applyEvent(state, event('proposal-drafted', proposal));
  state = applyEvent(state, event('proposal-approved'));
  state = applyEvent(state, event('execution-started', { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', owner: 'lead', repoPath: 'C:/project' }));
  const runtime: RuntimeAdapter = {
    async startSolo() { throw new Error('not used'); }, async resumeSolo() { throw new Error('not used'); },
    async inspect(ref) { return { state: 'live', ref }; }
  };
  await expect(assertExecutionSettled(state, runtime)).rejects.toThrow(/must settle/);
  runtime.inspect = async ref => ({ state: 'settled', outcome: 'completed', ref });
  await expect(assertExecutionSettled(state, runtime)).resolves.toBeUndefined();
  const revised = applyEvent(state, event('goal-revised', { ...spec, version: 2, outcome: 'new check in' }));
  expect(revised.status).toBe('draft');
  expect(revised.runtimeRef).toBeUndefined();
  expect(revised.proposal).toBeUndefined();
});
