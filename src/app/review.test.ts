import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, gateReport, DELIVERY, approval } from '../domain/fixtures.test-support.js';
import { ReviewService } from './review.js';
import { VerificationService } from './verification.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('requires an independent review of the delivery commit for a risky Solo Goal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-review-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  let n = 0;
  const add = (type: import('../domain/transitions.js').GoalEventType, data?: unknown) =>
    store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  add('proposal-drafted', { ...proposal, risks: ['Auth regression'] });
  add('proposal-approved');
  add('execution-started', { runId: 'run_1' });
  const verification = new VerificationService(store);
  verification.submitEvidence(spec.id, {
    acceptanceId: 'AC-1',
    result: 'pass',
    command: 'npm test',
    artifactRef: 'log:goal',
    commitRef: DELIVERY,
  });
  add('gate-recorded', gateReport(DELIVERY));
  expect(() => verification.verify(spec.id)).toThrow(/independent Goal review/i);
  const reviews = new ReviewService(store);
  expect(() =>
    reviews.submit(spec.id, {
      subject: 'goal',
      reviewer: 'lead',
      session: 'review-1',
      result: 'pass',
      commitRef: DELIVERY,
      note: 'Self review',
    }),
  ).toThrow(/reviewer must differ/i);
  expect(() =>
    reviews.submit(spec.id, {
      subject: 'goal',
      reviewer: 'reviewer-agent',
      result: 'pass',
      commitRef: DELIVERY,
      note: 'No session',
    }),
  ).toThrow();
  expect(() =>
    reviews.submit(spec.id, {
      subject: 'goal',
      reviewer: 'reviewer-agent',
      session: 'review-1',
      result: 'pass',
      commitRef: 'c'.repeat(40),
      note: 'Looks good',
    }),
  ).toThrow(/commit the controller gated/);
  expect(() => verification.verify(spec.id)).toThrow(/independent Goal review/i);
  reviews.submit(spec.id, {
    subject: 'goal',
    reviewer: 'reviewer-agent',
    session: 'review-1',
    result: 'pass',
    commitRef: DELIVERY,
    note: 'Checked auth and tests',
  });
  expect(verification.verify(spec.id).passed).toBe(true);
  store.close();
});
