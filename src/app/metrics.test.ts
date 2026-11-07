import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal } from '../domain/fixtures.test-support.js';
import { MetricsService } from './metrics.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('summarizes attempts, blockers and review rework from the durable event log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-metrics-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: import('../domain/transitions.js').GoalEventType, data?: unknown, at = '2026-11-08T00:00:00.000Z') => store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at });
  add('goal-drafted', spec); add('goal-approved'); add('goal-selected'); add('proposal-drafted', proposal); add('proposal-approved');
  add('execution-started', { runId: 'run_1' });
  add('review-submitted', { subject: 'goal', reviewer: 'reviewer-agent', result: 'changes', commitRef: 'abc', note: 'Needs regression test' });
  add('blocked', { kind: 'external', note: 'CI offline' }); add('unblocked');
  add('evidence-submitted', { acceptanceId: 'AC-1', result: 'pass', command: 'npm test', artifactRef: 'log:test' });
  add('verified'); add('outcome-accepted', undefined, '2026-11-08T00:01:00.000Z');
  expect(new MetricsService(store).show(spec.id)).toMatchObject({ attempts: 1, blockers: 1, reviewChanges: 1, cycleTimeMs: 60_000, status: 'closed' });
  store.close();
});
