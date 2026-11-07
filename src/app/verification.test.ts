import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal } from '../domain/fixtures.test-support.js';
import { VerificationService } from './verification.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const executing = () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-verify-')); dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) => store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec); add('goal-approved'); add('goal-selected'); add('proposal-drafted', proposal); add('proposal-approved'); add('execution-started', { runId: 'run_1' });
  return store;
};
const pass = { acceptanceId: 'AC-1', result: 'pass', command: 'npm test -- checkin', artifactRef: 'commit:abc123' } as const;

describe('verification gate', () => {
  it('rejects missing acceptance evidence and leaves Goal executing', () => {
    const store = executing();
    const service = new VerificationService(store);
    expect(() => service.verify(spec.id)).toThrow(/AC-1/);
    expect(store.getGoal(spec.id)?.status).toBe('executing');
    store.close();
  });
  it('rejects failed latest test evidence', () => {
    const store = executing();
    const service = new VerificationService(store);
    service.submitEvidence(spec.id, { ...pass, result: 'fail' });
    expect(() => service.verify(spec.id)).toThrow(/AC-1/);
    store.close();
  });
  it('keeps verified technical delivery open until Human outcome acceptance', () => {
    const store = executing();
    const service = new VerificationService(store);
    service.submitEvidence(spec.id, pass);
    expect(service.verify(spec.id).passed).toBe(true);
    expect(store.getGoal(spec.id)?.status).toBe('verified');
    service.recordOutcome(spec.id, 'close');
    expect(store.getGoal(spec.id)?.status).toBe('closed');
    store.close();
  });
  it('does not infer automatic merge from evidence or closure', () => {
    const store = executing();
    const service = new VerificationService(store);
    service.submitEvidence(spec.id, pass);
    service.verify(spec.id);
    expect(service.mayAutoMerge(spec.id)).toBe(false);
    store.close();
  });
});
