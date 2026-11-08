import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, gateReport, DELIVERY } from '../domain/fixtures.test-support.js';
import { VerificationService } from './verification.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
let n = 0;
const executing = () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-verify-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite')); stores.push(store);
  const add = (type: GoalEventType, data?: unknown) => store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec); add('goal-approved'); add('goal-selected'); add('proposal-drafted', proposal); add('proposal-approved'); add('execution-started', { runId: 'run_1' });
  return { store, add };
};
const pass = { acceptanceId: 'AC-1', result: 'pass', command: 'npm test -- checkin', artifactRef: 'commit:abc123' } as const;

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
  it('drops the gate when the owner is resumed for another attempt', () => {
    const { store, add } = executing();
    add('gate-recorded', gateReport(DELIVERY));
    add('checkpointed', { phase: 'repair', progress: 'fix', evidenceRefs: [] });
    add('resume-intended', 'key-2'); add('runtime-resumed', { runId: 'run_1', dispatchId: 'ctx_2' });
    expect(() => new VerificationService(store).verify(spec.id)).toThrow(/no controller gate/);
  });
  it('rejects a gate that finishes after the owner was resumed, because it judged the earlier attempt', () => {
    const { store, add } = executing();
    const stale = gateReport(DELIVERY);
    add('checkpointed', { phase: 'repair', progress: 'fix', evidenceRefs: [] });
    add('resume-intended', 'key-2'); add('runtime-resumed', { runId: 'run_1', dispatchId: 'ctx_2' });
    expect(() => add('gate-recorded', stale)).toThrow(/earlier owner attempt/);
  });
  it('keeps verified technical delivery open until Human outcome acceptance', () => {
    const { store, add } = executing();
    const service = new VerificationService(store);
    add('gate-recorded', gateReport(DELIVERY));
    expect(service.verify(spec.id, DELIVERY).passed).toBe(true);
    expect(store.getGoal(spec.id)?.status).toBe('verified');
    service.recordOutcome(spec.id, 'close');
    expect(store.getGoal(spec.id)?.status).toBe('closed');
  });
  it('does not infer automatic merge from a gate or closure', () => {
    const { store, add } = executing();
    const service = new VerificationService(store);
    add('gate-recorded', gateReport(DELIVERY));
    service.verify(spec.id);
    expect(service.mayAutoMerge(spec.id)).toBe(false);
  });
});
