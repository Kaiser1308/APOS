import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, approval, BASE, DELIVERY, gateReport } from '../domain/fixtures.test-support.js';
import { MetricsService } from './metrics.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DELIVERY2 = 'c'.repeat(40);

it('summarizes submits per package, red gates and minutes from the durable event log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-metrics-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: GoalEventType, data?: unknown, at = '2026-11-08T00:00:00.000Z') =>
    store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at });
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected', undefined, '2026-11-08T00:00:00.000Z');
  add('proposal-drafted', proposal);
  add('proposal-approved');
  const submit = (commit: string) =>
    add('package-submitted', { packageId: 'WP-MAIN', version: 1, commit, base: BASE, by: 'lead' });
  submit(DELIVERY);
  add('package-gate-recorded', { packageId: 'WP-MAIN', report: gateReport(DELIVERY, 'red') });
  submit(DELIVERY2);
  add('package-gate-recorded', {
    packageId: 'WP-MAIN',
    report: gateReport(DELIVERY2, 'green', spec, 'WP-MAIN@1:1'),
  });
  add('verified', { deliveryCommit: DELIVERY2 }, '2026-11-08T00:30:00.000Z');
  expect(new MetricsService(store).show(spec.id)).toEqual({
    goalId: spec.id,
    status: 'verified',
    submitsByPackage: { 'WP-MAIN': 2 },
    redGates: 1,
    minutes: 30,
  });
  store.close();
});
