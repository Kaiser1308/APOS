import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, gateReport, DELIVERY, BASE, approval } from '../domain/fixtures.test-support.js';
import { VerificationService } from './verification.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
let n = 0;
const executing = () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-verify-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  stores.push(store);
  const add = (type: GoalEventType, data?: unknown) =>
    store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  add('proposal-drafted', proposal);
  add('proposal-approved');
  /** The Solo package is submitted and its gate comes back green, as `apos package submit` records it. */
  const green = (commit = DELIVERY) => {
    add('package-submitted', { packageId: 'WP-MAIN', version: 1, commit, base: BASE, by: 'lead' });
    add('package-gate-recorded', { packageId: 'WP-MAIN', report: gateReport(commit) });
  };
  return { store, add, green };
};
const pass = {
  acceptanceId: 'AC-1',
  result: 'pass',
  command: 'npm test -- checkin',
  artifactRef: 'commit:abc123',
} as const;

describe('verification gate', () => {
  it('rejects a self-declared pass when the controller has not run the gate', () => {
    const { store } = executing();
    const service = new VerificationService(store);
    service.submitEvidence(spec.id, pass);
    expect(() => service.verify(spec.id)).toThrow(/no controller gate/);
    expect(store.getGoal(spec.id)?.status).toBe('executing');
  });
  it('rejects a red gate even when the owner reported pass', () => {
    const { store, add } = executing();
    const service = new VerificationService(store);
    service.submitEvidence(spec.id, pass);
    add('gate-recorded', gateReport(DELIVERY, 'red'));
    expect(() => service.verify(spec.id)).toThrow(/gate is red/);
  });
  it('rejects a green gate that ran on a different commit than the one under review', () => {
    const { store, add } = executing();
    add('gate-recorded', gateReport(DELIVERY));
    expect(() => new VerificationService(store).verify(spec.id, 'c'.repeat(40))).toThrow(/not c{40}/);
  });
  it('rejects an unverifiable gate', () => {
    const { store, add } = executing();
    add('gate-recorded', gateReport(DELIVERY, 'unverifiable'));
    expect(() => new VerificationService(store).verify(spec.id)).toThrow(/unverifiable/);
  });
  it('drops the gate when the Lead revises its plan', () => {
    const { store, add } = executing();
    add('gate-recorded', gateReport(DELIVERY));
    add('proposal-revised', { ...proposal, version: 2 });
    expect(() => new VerificationService(store).verify(spec.id)).toThrow(/Goal must be executing/);
    expect(store.getGoal(spec.id)?.gate).toBeUndefined();
  });
  it('rejects a gate that finishes after its package moved on, because it judged an earlier attempt', () => {
    const { add } = executing();
    const stale = gateReport(DELIVERY, 'green', spec, 'WP-MAIN@1:1');
    expect(() => add('gate-recorded', stale)).toThrow(/earlier package attempt/);
  });
  it('keeps verified technical delivery open until Human outcome acceptance', () => {
    const { store, green } = executing();
    const service = new VerificationService(store);
    green();
    expect(service.verify(spec.id, DELIVERY).passed).toBe(true);
    expect(store.getGoal(spec.id)?.status).toBe('verified');
    service.recordOutcome(spec.id, 'close');
    expect(store.getGoal(spec.id)?.status).toBe('closed');
  });
  it('does not infer merge permission from a green gate or verification', () => {
    const { store, add, green } = executing();
    green();
    new VerificationService(store).verify(spec.id);
    expect(store.getGoal(spec.id)?.mergeAuthorization).toBeUndefined();
    expect(() => add('merge-completed', { sourceRef: DELIVERY, targetBranch: 'main', mergeCommit: DELIVERY })).toThrow(
      /Human merge authorization/,
    );
  });
});
