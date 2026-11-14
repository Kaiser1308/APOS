import { describe, expect, it } from 'vitest';
import { applyEvent, type GoalEvent, type GoalState } from './transitions.js';
import { spec, proposal, approval } from './fixtures.test-support.js';

let counter = 0;
const event = (type: GoalEvent['type'], data?: unknown): GoalEvent => ({ id: `HO-${++counter}`, goalId: spec.id, type, data, at: '2026-11-14T00:00:00.000Z' });
const start = (): GoalState => applyEvent(undefined, event('goal-drafted', spec));

describe('handing an owner to another agent', () => {
  const leadRef = { runId: 'run_1', taskId: 't1', dispatchId: 'ctx_1', repoPath: 'C:/repo', terminal: 'term_1', worktreeId: 'repo::C:/wt', baseCommit: 'b'.repeat(40), requested: { agent: 'codex' } };
  const executingSolo = () => {
    let state = applyEvent(start(), event('goal-approved', approval));
    state = applyEvent(state, event('goal-selected'));
    state = applyEvent(state, event('lead-dispatch-intended', 'lk'));
    state = applyEvent(state, event('lead-started', leadRef));
    state = applyEvent(state, event('proposal-drafted', proposal));
    state = applyEvent(state, event('proposal-approved'));
    return applyEvent(state, event('execution-started', { ...leadRef, owner: 'lead' }));
  };
  const handed = { runId: 'run_1', taskId: 't9', dispatchId: 'ctx_9', owner: 'lead', repoPath: 'C:/repo', terminal: 'term_9', worktreeId: 'repo::C:/wt', baseCommit: 'b'.repeat(40), requested: { agent: 'claude' } };

  it('moves the Solo owner to the new dispatch and terminal without spending an attempt', () => {
    let state = executingSolo();
    expect(state.soloAttempts).toBe(1);
    state = applyEvent(state, event('handoff-intended', { key: 'h1', target: { kind: 'lead' }, from: 'ctx_1' }));
    expect(state.handoffIntent).toMatchObject({ key: 'h1', from: 'ctx_1' });
    expect(() => applyEvent(state, event('handoff-intended', { key: 'h2', target: { kind: 'lead' }, from: 'ctx_1' }))).toThrow(/A handoff is already pending/);
    expect(() => applyEvent(state, event('owner-handed-off', { key: 'other', target: { kind: 'lead' }, from: 'ctx_1', ref: handed }))).toThrow(/pending handoff/);
    state = applyEvent(state, event('owner-handed-off', { key: 'h1', target: { kind: 'lead' }, from: 'ctx_1', ref: handed }));
    expect(state.soloAttempts).toBe(1);
    expect(state.runtimeRef).toMatchObject({ dispatchId: 'ctx_9', terminal: 'term_9', worktreeId: 'repo::C:/wt', baseCommit: 'b'.repeat(40), requested: { agent: 'claude' } });
    expect(state.lead?.current).toBe('ctx_9');
    expect(state.lead?.ref.terminal).toBe('term_9');
    // The next Multi-WP wake reads leadTerminal: it must go to the new terminal, not the closed one.
    expect(state.leadTerminal).toEqual({ terminal: 'term_9', worktree: 'id:repo::C:/wt', runId: 'run_1' });
    expect(state.handoffIntent).toBeUndefined();
  });

  it('clears a block when the handoff says so, and an abandoned handoff only clears its intent', () => {
    let state = executingSolo();
    state = applyEvent(state, event('blocked', { kind: 'technical', note: 'needs-decision: owner reported failed on attempt 1 without a delivery report' }));
    state = applyEvent(state, event('handoff-intended', { key: 'h1', target: { kind: 'lead' }, from: 'ctx_1' }));
    const abandoned = applyEvent(state, event('intent-abandoned', { key: 'h1', reason: 'Orca could not confirm the stop' }));
    expect(abandoned.handoffIntent).toBeUndefined();
    expect(abandoned.status).toBe('blocked');
    state = applyEvent(state, event('owner-handed-off', { key: 'h1', target: { kind: 'lead' }, from: 'ctx_1', ref: handed, unblock: true }));
    expect(state.status).toBe('executing');
    expect(state.blocker).toBeUndefined();
  });

  it('moves a package to its new Worker without spending an attempt', () => {
    const pkg = { id: 'WP-01', goalId: spec.id, goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['scan()@v1'], acceptance: [{ id: 'WP-AC-1', text: 'scan', goalAcceptanceId: 'AC-1' }], integration: 'Lead' };
    let state = applyEvent(start(), event('goal-approved', approval));
    state = applyEvent(state, event('goal-selected'));
    state = applyEvent(state, event('proposal-drafted', { ...proposal, mode: 'multi-wp' }));
    state = applyEvent(state, event('package-added', pkg));
    state = applyEvent(state, event('package-added', { ...pkg, id: 'WP-02', owner: 'worker-b', scope: ['history'], acceptance: [{ id: 'WP-AC-2', text: 'h' }] }));
    state = applyEvent(state, event('proposal-approved'));
    state = applyEvent(state, event('package-dispatch-intended', { packageId: 'WP-01', key: 'k' }));
    state = applyEvent(state, event('package-started', { packageId: 'WP-01', ref: { runId: 'run_p', taskId: 'p', dispatchId: 'ctx_p', owner: 'worker', repoPath: 'C:/repo', worktreeId: 'repo::C:/p' } }));
    state = applyEvent(state, event('package-blocked', { packageId: 'WP-01', blocker: { kind: 'technical', note: 'Worker reported failed on WP-01 v1 attempt 1' } }));
    state = applyEvent(state, event('handoff-intended', { key: 'h1', target: { kind: 'package', packageId: 'WP-01' }, from: 'ctx_p' }));
    state = applyEvent(state, event('owner-handed-off', { key: 'h1', target: { kind: 'package', packageId: 'WP-01' }, from: 'ctx_p', unblock: true, ref: { runId: 'run_p', taskId: 'p2', dispatchId: 'ctx_p2', owner: 'worker', repoPath: 'C:/repo', worktreeId: 'repo::C:/p', requested: { agent: 'claude' } } }));
    expect(state.packages!['WP-01']).toMatchObject({ status: 'executing', attempts: 1, runtimeRef: { dispatchId: 'ctx_p2' } });
    expect(state.packages!['WP-01'].blocker).toBeUndefined();
  });

  it('replaces the reviewer of the gated commit', () => {
    let state = executingSolo();
    state = { ...state, reviewDispatch: { dispatchId: 'ctx_r', runId: 'run_1', key: 'rk', commit: 'c'.repeat(40) } };
    state = applyEvent(state, event('handoff-intended', { key: 'h1', target: { kind: 'reviewer' }, from: 'ctx_r' }));
    state = applyEvent(state, event('owner-handed-off', { key: 'h1', target: { kind: 'reviewer' }, from: 'ctx_r', ref: { dispatchId: 'ctx_r2', runId: 'run_1', key: 'rk2', commit: 'c'.repeat(40), terminal: 'term_r2', requested: { agent: 'claude' } } }));
    expect(state.reviewDispatch).toMatchObject({ dispatchId: 'ctx_r2', key: 'rk2', commit: 'c'.repeat(40) });
  });
});
