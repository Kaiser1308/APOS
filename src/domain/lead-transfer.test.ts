import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEvent, type GoalEvent, type GoalState } from './transitions.js';
import { spec, proposal, approval } from './fixtures.test-support.js';
import { EventLog, verifyChain } from '../store/event-log.js';
import { InvariantError } from './errors.js';

let counter = 0;
const event = (type: GoalEvent['type'], data?: unknown): GoalEvent => ({
  id: `LT-${++counter}`,
  goalId: spec.id,
  type,
  data,
  at: '2026-11-20T00:00:00.000Z',
});
const leadRef = {
  runId: 'run_1',
  taskId: 't1',
  dispatchId: 'ctx_1',
  repoPath: 'C:/repo',
  terminal: 'term_1',
  worktreeId: 'repo::C:/wt',
  baseCommit: 'b'.repeat(40),
};
const bot = { id: 'bot-1', name: 'Lead APOS' };
const target = { kind: 'bot', botId: bot.id, botName: bot.name };
const planning = (): GoalEvent[] => [
  event('goal-drafted', spec),
  event('goal-approved', approval),
  event('goal-selected'),
  event('lead-dispatch-intended', 'lk'),
  event('lead-started', leadRef),
];
const replay = (events: GoalEvent[]): GoalState =>
  events.reduce<GoalState | undefined>((state, item) => applyEvent(state, item), undefined)!;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('moving a Lead to an Orca bot', () => {
  it('records the bot, who moved it and when, only to settle a pending transfer', () => {
    const base = replay(planning());
    expect(() => applyEvent(base, event('lead-transferred', { key: 'k1', from: 'ctx_1', by: 'anh', bot }))).toThrow(
      /pending transfer to a bot/,
    );
    expect(() => applyEvent(base, event('lead-transferred', { key: 'k1', from: 'ctx_1', by: 'anh', bot }))).toThrow(
      InvariantError,
    );
    const pending = applyEvent(base, event('handoff-intended', { key: 'k1', target, from: 'ctx_1' }));
    expect(() => applyEvent(pending, event('lead-transferred', { key: 'k1', from: 'ctx_1', by: ' ', bot }))).toThrow(
      /who transferred/,
    );
    expect(() =>
      applyEvent(
        pending,
        event('lead-transferred', { key: 'k1', from: 'ctx_1', by: 'anh', bot: { id: 'other', name: 'X' } }),
      ),
    ).toThrow(/bot \(id and name\)/);
    const moved = applyEvent(pending, event('lead-transferred', { key: 'k1', from: 'ctx_1', by: 'anh', bot }));
    expect(moved.leadBot).toEqual({ ...bot, by: 'anh', at: '2026-11-20T00:00:00.000Z' });
    expect(moved.handoffIntent).toBeUndefined();
    // A transfer is not a handoff to a fresh agent: owner-handed-off cannot settle it.
    expect(() =>
      applyEvent(pending, event('owner-handed-off', { key: 'k1', target, from: 'ctx_1', ref: { dispatchId: 'x' } })),
    ).toThrow(/settles with lead-transferred/);
    expect(() =>
      applyEvent(pending, event('owner-handed-off', { key: 'k1', target, from: 'ctx_1', ref: { dispatchId: 'x' } })),
    ).toThrow(InvariantError);
    // An unknown target kind is an event APOS never builds.
    expect(() =>
      applyEvent(base, event('handoff-intended', { key: 'k2', target: { kind: 'ghost' }, from: 'ctx_1' })),
    ).toThrow(InvariantError);
  });

  it('refuses a Solo plan being delivered by its Lead: that Lead is writing the code', () => {
    const solo = replay([
      ...planning(),
      event('proposal-drafted', proposal),
      event('proposal-approved'),
      event('execution-started', { ...leadRef, owner: 'lead' }),
      event('handoff-intended', { key: 'k1', target, from: 'ctx_1' }),
    ]);
    expect(() => applyEvent(solo, event('lead-transferred', { key: 'k1', from: 'ctx_1', by: 'anh', bot }))).toThrow(
      /planning Lead or the Lead of a running Multi-WP Goal/,
    );
  });

  it("gives a bot's Solo plan its own owner dispatch, and hands only that owner to a fresh agent", () => {
    const owned = replay([
      ...planning(),
      event('handoff-intended', { key: 'k1', target, from: 'ctx_1' }),
      event('lead-transferred', { key: 'k1', from: 'ctx_1', by: 'anh', bot }),
      event('proposal-drafted', proposal),
      event('proposal-approved'),
    ]);
    // Without an intent the controller did not start it: refused, as is the Lead's own dispatch.
    expect(() => applyEvent(owned, event('execution-started', { ...leadRef, dispatchId: 'ctx_2' }))).toThrow(
      /dispatch intent/,
    );
    expect(() => applyEvent(owned, event('execution-started', { ...leadRef, dispatchId: 'ctx_2' }))).toThrow(
      InvariantError,
    );
    let state = applyEvent(owned, event('dispatch-intended', 'd1'));
    state = applyEvent(state, event('execution-started', { ...leadRef, dispatchId: 'ctx_2', owner: 'lead' }));
    expect(state).toMatchObject({ status: 'executing', runtimeRef: { dispatchId: 'ctx_2' }, leadBot: bot });
    expect(state.lead?.current).toBe('ctx_1');
    // While the bot holds the Lead, a Lead handoff may only replace the Solo owner, never the stopped Lead.
    const atLead = applyEvent(state, event('handoff-intended', { key: 'h0', target: { kind: 'lead' }, from: 'ctx_1' }));
    expect(() =>
      applyEvent(
        atLead,
        event('owner-handed-off', { key: 'h0', target: { kind: 'lead' }, from: 'ctx_1', ref: { dispatchId: 'x' } }),
      ),
    ).toThrow(InvariantError);
    state = applyEvent(state, event('handoff-intended', { key: 'h1', target: { kind: 'lead' }, from: 'ctx_2' }));

    state = applyEvent(
      state,
      event('owner-handed-off', {
        key: 'h1',
        target: { kind: 'lead' },
        from: 'ctx_2',
        ref: { ...leadRef, dispatchId: 'ctx_3' },
      }),
    );
    expect(state.runtimeRef?.dispatchId).toBe('ctx_3');
    expect(state.lead?.current).toBe('ctx_1');
    expect(state.leadBot).toMatchObject(bot);
  });

  it('replays and verifies through the hash-chained log: moved to the bot, then back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-lead-transfer-'));
    dirs.push(dir);
    const log = new EventLog(dir);
    const events = [
      ...planning(),
      event('handoff-intended', { key: 'k1', target, from: 'ctx_1' }),
      event('lead-transferred', { key: 'k1', from: 'ctx_1', by: 'anh', bot }),
    ];
    for (const item of events) log.append(item);
    expect(replay(new EventLog(dir).read(spec.id)).leadBot).toMatchObject({ ...bot, by: 'anh' });
    expect(() => applyEvent(replay(events), event('lead-returned', { by: 'anh', botId: 'other' }))).toThrow(
      /bot that holds it/,
    );
    log.append(event('lead-returned', { by: 'anh', botId: bot.id }));
    const lines = readFileSync(join(dir, 'events', `${spec.id}.jsonl`), 'utf8')
      .trim()
      .split('\n');
    expect(
      verifyChain(spec.id, lines)
        .map(line => line.event.type)
        .slice(-3),
    ).toEqual(['handoff-intended', 'lead-transferred', 'lead-returned']);
    const after = replay(new EventLog(dir).read(spec.id));
    expect(after.leadBot).toBeUndefined();
    expect(after.lead?.current).toBe('ctx_1');
  });
});
