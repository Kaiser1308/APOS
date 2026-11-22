import { describe, expect, it } from 'vitest';
import { LEGACY_EVENT_TYPES } from './legacy-events.js';
import {
  applyEvent,
  effectiveStatus,
  isWritableEventType,
  SOLO_PACKAGE_ID,
  type GoalEvent,
  type GoalState,
} from './transitions.js';
import { BASE, DELIVERY, gateReport, spec, proposal, approval } from './fixtures.test-support.js';

let counter = 0;
const event = (type: string, data?: unknown): GoalEvent => ({
  id: `EV-${++counter}`,
  goalId: spec.id,
  type: type as GoalEvent['type'],
  data,
  at: '2026-11-07T00:00:00.000Z',
});
const start = (): GoalState => applyEvent(undefined, event('goal-drafted', spec));
const selected = (): GoalState => {
  const state = applyEvent(start(), event('goal-approved', approval));
  return applyEvent(state, event('goal-selected'));
};
const executingSolo = (): GoalState => {
  let state = applyEvent(selected(), event('proposal-drafted', proposal));
  state = applyEvent(state, event('proposal-approved'));
  return state;
};
const submit = (state: GoalState, commit = DELIVERY) =>
  applyEvent(
    state,
    event('package-submitted', {
      packageId: SOLO_PACKAGE_ID,
      version: 1,
      commit,
      base: BASE,
      by: 'lead',
    }),
  );
const record = (state: GoalState, result: 'green' | 'red' | 'unverifiable', commit = DELIVERY) => {
  const item = state.packages![SOLO_PACKAGE_ID];
  return applyEvent(
    state,
    event('package-gate-recorded', {
      packageId: SOLO_PACKAGE_ID,
      report: gateReport(commit, result, spec, `${SOLO_PACKAGE_ID}@1:${item.attempts}`),
    }),
  );
};

describe('approval gates', () => {
  it('does not start work after Goal approval alone', () => {
    const approved = applyEvent(start(), event('goal-approved', approval));
    expect(() => applyEvent(approved, event('proposal-approved'))).toThrow();
    expect(approved.status).toBe('approved');
  });
  it('rejects proposal approval when a Goal criterion is not mapped', () => {
    const state = applyEvent(
      selected(),
      event('proposal-drafted', { ...proposal, acceptanceMapping: [{ acceptanceId: 'OTHER', verification: 'test' }] }),
    );
    expect(() => applyEvent(state, event('proposal-approved'))).toThrow(/verification mapping/);
  });
  it('starts executing the moment the current proposal is approved, with the implicit WP-MAIN for a Solo plan', () => {
    const state = executingSolo();
    expect(state.status).toBe('executing');
    const main = state.packages?.[SOLO_PACKAGE_ID];
    expect(main).toMatchObject({ status: 'pending', attempts: 0 });
    expect(main?.spec.acceptance.map(item => item.goalAcceptanceId)).toEqual(spec.acceptance.map(item => item.id));
    expect(main?.spec.acceptance[0]?.checkIds).toEqual(['CHK-1']);
  });
  it('invalidates plan approval after Goal revision', () => {
    const state = applyEvent(executingSolo(), event('goal-revised', { ...spec, version: 2 }));
    expect(state.proposalApprovedVersion).toBeUndefined();
    expect(state.status).toBe('draft');
    expect(state.packages).toEqual({});
  });
  it('does not restart a closed Goal', () => {
    let state = record(submit(executingSolo()), 'green');
    state = applyEvent(state, event('verified', { deliveryCommit: DELIVERY }));
    state = applyEvent(state, event('outcome-accepted'));
    expect(state.status).toBe('closed');
    expect(() => submit(state)).toThrow(/terminal/);
  });
  it('records a blocker and requires an explicit unblock event to resume', () => {
    let state = applyEvent(executingSolo(), event('blocked', { kind: 'external', note: 'API unavailable' }));
    expect(state.status).toBe('blocked');
    expect(() => applyEvent(state, event('verified'))).toThrow();
    state = applyEvent(state, event('decision-logged', { note: 'API restored' }));
    expect(state.status).toBe('blocked');
    expect(applyEvent(state, event('unblocked')).status).toBe('executing');
  });
  it('holds Multi-WP packages as versioned Goal-owned state', () => {
    let state = applyEvent(selected(), event('proposal-drafted', { ...proposal, mode: 'multi-wp' }));
    const wp = {
      id: 'WP-01',
      goalId: spec.id,
      goalVersion: 1,
      version: 1,
      owner: 'worker-a',
      outcome: 'QR intake works',
      scope: ['scanner'],
      exclusions: [],
      dependencies: [],
      interfaces: ['checkIn(token) -> result@v1'],
      acceptance: [{ id: 'WP-AC-1', text: 'valid token checks in', goalAcceptanceId: 'AC-1' }],
      integration: 'Lead runs check-in flow',
    };
    state = applyEvent(state, event('package-added', wp));
    expect(state.packages?.['WP-01']).toMatchObject({ status: 'pending', spec: { version: 1 } });
    expect(() => applyEvent(state, event('package-added', wp))).toThrow(/already exists/i);
    expect(() => applyEvent(state, event('proposal-approved'))).toThrow(/at least two packages/i);
    state = applyEvent(
      state,
      event('package-added', {
        ...wp,
        id: 'WP-02',
        owner: 'worker-b',
        acceptance: [{ id: 'WP-AC-2', text: 'history works' }],
      }),
    );
    const approved = applyEvent(state, event('proposal-approved'));
    expect(approved.status).toBe('executing');
    expect(Object.keys(approved.packages ?? {})).toEqual(['WP-01', 'WP-02']);
  });
});

describe('package submissions', () => {
  it('goes pending, submitted, then green, and a green Solo package can verify the Goal', () => {
    let state = submit(executingSolo());
    expect(state.packages?.[SOLO_PACKAGE_ID]?.status).toBe('submitted');
    state = record(state, 'green');
    expect(state.packages?.[SOLO_PACKAGE_ID]).toMatchObject({ status: 'green', attempts: 0 });
    expect(state.gate?.deliveryCommit).toBe(DELIVERY);
    state = applyEvent(state, event('verified', { deliveryCommit: DELIVERY }));
    expect(state).toMatchObject({ status: 'verified', verifiedCommit: DELIVERY });
  });
  it('refuses to verify a Solo Goal whose package is not green', () => {
    expect(() => applyEvent(executingSolo(), event('verified'))).toThrow(/green/);
    expect(() => applyEvent(record(submit(executingSolo()), 'red'), event('verified'))).toThrow(/green/);
  });
  it('counts a red gate and lets the package be submitted again', () => {
    let state = record(submit(executingSolo()), 'red');
    expect(state.packages?.[SOLO_PACKAGE_ID]).toMatchObject({ status: 'red', attempts: 1 });
    expect(state.status).toBe('executing');
    state = record(submit(state, 'c'.repeat(40)), 'green', 'c'.repeat(40));
    expect(state.packages?.[SOLO_PACKAGE_ID]?.status).toBe('green');
  });
  it('blocks the Goal once the red count passes the approved attempts', () => {
    let state = executingSolo();
    for (let n = 0; n < 3; n++) {
      state = record(submit(state), 'red');
      expect(state.status).toBe('executing');
    }
    state = record(submit(state), 'red');
    expect(state).toMatchObject({ status: 'blocked', blocker: { kind: 'technical' } });
    expect(() => submit(state)).toThrow(/Executing Goal required/);
  });
  it('sends an unverifiable gate to a Human instead of counting an attempt', () => {
    const state = record(submit(executingSolo()), 'unverifiable');
    expect(state.packages?.[SOLO_PACKAGE_ID]).toMatchObject({ status: 'needs-human', attempts: 0 });
    expect(submit(state).packages?.[SOLO_PACKAGE_ID]?.status).toBe('submitted');
  });
  it('rejects a gate for another commit or attempt, and a gate for a package that was never submitted', () => {
    expect(() => record(executingSolo(), 'green')).toThrow(/submitted commit/);
    expect(() => record(submit(executingSolo()), 'green', 'c'.repeat(40))).toThrow(/submitted commit/);
  });
  it('refuses to submit a green package or a short commit', () => {
    const green = record(submit(executingSolo()), 'green');
    expect(green.status).toBe('verified');
    expect(() => submit(green)).toThrow(/Executing Goal required/);
    expect(() => submit(executingSolo(), 'abc')).toThrow(/Full commit/);
  });
});

describe('legacy Goals', () => {
  it('turns legacy on the first orchestration event and keeps what was known', () => {
    const legacy = applyEvent(selected(), event('lead-dispatch-intended', 'key'));
    expect(legacy.status).toBe('legacy');
    expect(legacy.selected).toBe(true);
    expect(legacy.spec.id).toBe(spec.id);
  });
  it('never throws on the old events that follow, and keeps how the Goal ended', () => {
    let state = applyEvent(selected(), event('lead-started', { dispatchId: 'x' }));
    for (const type of [
      'proposal-drafted',
      'execution-started',
      'worker-settled',
      'gate-recorded',
      'package-gate-recorded',
    ])
      state = applyEvent(state, event(type, {}));
    expect(state.status).toBe('legacy');
    state = applyEvent(state, event('verified'));
    expect(state.legacyOutcome).toBe('verified');
    state = applyEvent(state, event('outcome-accepted'));
    expect(effectiveStatus(state)).toBe('closed');
    expect(state.status).toBe('legacy');
  });
  it('replays every legacy event type without throwing', () => {
    for (const type of LEGACY_EVENT_TYPES) expect(() => applyEvent(selected(), event(type, {}))).not.toThrow();
  });
  it('is not writable: append refuses legacy and unknown event types', () => {
    for (const type of LEGACY_EVENT_TYPES) expect(isWritableEventType(type), type).toBe(false);
    expect(isWritableEventType('something-new')).toBe(false);
    expect(isWritableEventType('package-submitted')).toBe(true);
  });
});

describe('closing and the time budget', () => {
  const verified = (commit = DELIVERY) =>
    applyEvent(record(submit(executingSolo(), commit), 'green', commit), event('verified', { deliveryCommit: commit }));

  it('closes only on the commit that went green', () => {
    expect(applyEvent(verified(), event('outcome-accepted')).status).toBe('closed');
  });
  it('refuses to close a Goal whose verified commit is not the one the last gate passed', () => {
    const state = verified();
    expect(() => applyEvent({ ...state, verifiedCommit: 'c'.repeat(40) }, event('outcome-accepted'))).toThrow(
      /last green gate/,
    );
    expect(() => applyEvent({ ...state, verifiedCommit: undefined }, event('outcome-accepted'))).toThrow(
      /last green gate/,
    );
  });
  it('refuses to close when the last gate is not green, even if the Goal was verified', () => {
    const state = verified();
    const red = { ...state, gate: { ...state.gate!, result: 'red' as const } };
    expect(() => applyEvent(red, event('outcome-accepted'))).toThrow(/last green gate/);
  });
  it('refuses a Multi-WP close unless the verified commit is the integration commit', () => {
    const state = verified();
    const multi = {
      ...state,
      proposal: { ...state.proposal!, mode: 'multi-wp' as const },
      integration: { commitRef: 'd'.repeat(40) },
    };
    expect(() => applyEvent(multi, event('outcome-accepted'))).toThrow(/integration commit/);
  });
  it('refuses a submission after the approved minutes, counted from goal select', () => {
    const late: GoalEvent = {
      ...event('package-submitted', {
        packageId: SOLO_PACKAGE_ID,
        version: 1,
        commit: DELIVERY,
        base: BASE,
        by: 'lead',
      }),
      at: '2026-11-07T05:00:00.000Z',
    };
    expect(() => applyEvent(executingSolo(), late)).toThrow(/time budget/);
    const inTime = { ...late, at: '2026-11-07T03:59:00.000Z' };
    expect(applyEvent(executingSolo(), inTime).packages?.[SOLO_PACKAGE_ID]?.status).toBe('submitted');
  });
});
