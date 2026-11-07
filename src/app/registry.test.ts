import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal } from '../domain/fixtures.test-support.js';
import { GoalRegistryService } from './registry.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'apos-registry-')); dirs.push(dir); return SqliteStore.open(join(dir, 'state.sqlite')); };

it('recommends and selects only Goals whose dependencies have closed', () => {
  const store = fixture();
  let n = 0;
  const add = (goalId: string, type: import('../domain/transitions.js').GoalEventType, data?: unknown) => store.append({ id: `EV-${++n}`, goalId, type, data, at: '2026-11-08T00:00:00.000Z' });
  const second = { ...spec, id: 'GOAL-002', dependencies: [spec.id], priority: 0 };
  add(spec.id, 'goal-drafted', spec); add(second.id, 'goal-drafted', second);
  const registry = new GoalRegistryService(store);
  registry.approve(spec.id); registry.approve(second.id);
  expect(registry.recommend()?.spec.id).toBe(spec.id);
  expect(() => registry.select(second.id)).toThrow(/dependencies not closed/);
  registry.select(spec.id);
  add(spec.id, 'proposal-drafted', proposal); add(spec.id, 'proposal-approved'); add(spec.id, 'execution-started', { runId: 'run_1' }); add(spec.id, 'verified'); add(spec.id, 'outcome-accepted');
  expect(registry.recommend()?.spec.id).toBe(second.id);
  registry.select(second.id);
  expect(store.getGoal(second.id)?.selected).toBe(true);
  store.close();
});

it('rejects a dependency cycle before Goal approval', () => {
  const store = fixture();
  store.append({ id: 'EV-1', goalId: spec.id, type: 'goal-drafted', data: { ...spec, dependencies: ['GOAL-002'] }, at: '2026-11-08T00:00:00.000Z' });
  store.append({ id: 'EV-2', goalId: 'GOAL-002', type: 'goal-drafted', data: { ...spec, id: 'GOAL-002', dependencies: [spec.id] }, at: '2026-11-08T00:00:00.000Z' });
  expect(() => new GoalRegistryService(store).approve(spec.id)).toThrow(/cycle/);
  expect(store.getGoal(spec.id)?.status).toBe('draft');
  store.close();
});
