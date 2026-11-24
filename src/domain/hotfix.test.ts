import { describe, expect, it } from 'vitest';
import { newEvent } from '../app/events.js';
import { parseGoalSpec } from './contracts.js';
import {
  dueAtOf,
  dueMs,
  hotfixCheck,
  hotfixGoalDraft,
  hotfixRows,
  hotfixStatus,
  redNote,
  unprovenCount,
} from './hotfix.js';
import { applyEvent, type GoalEvent, type GoalState } from './transitions.js';

const commit = 'a'.repeat(40);
const before = 'b'.repeat(40);
const now = '2026-11-24T08:00:00.000Z';
const link = { commit, before, due: '24h', dueAt: dueAtOf(now, '24h')! };
const report = { given: 'a cart of 40 and FREE0', when: 'the total is computed', then: 'the total is 40' };
const accepted = {
  commit,
  before,
  description: 'checkout total is wrong',
  due: '24h',
  dueAt: link.dueAt,
  acceptedAt: now,
  by: 'on-behalf',
  onBehalf: 'demo',
};
const replay = (events: GoalEvent[]): GoalState => events.reduce<GoalState | undefined>(applyEvent, undefined)!;
const drafted = (spec = hotfixGoalDraft({ id: 'GOAL-BUG-001', description: 'x', link, now }).spec) =>
  newEvent(spec.id, 'goal-drafted', spec);

describe('--due', () => {
  it('is a whole number with its unit, and a bare number is refused', () => {
    expect(dueMs('90m')).toBe(90 * 60_000);
    expect(dueMs('24h')).toBe(86_400_000);
    expect(dueMs('2d')).toBe(2 * 86_400_000);
    for (const bad of ['24', '1.5h', 'soon', '0h', '-1h', ''] as const) expect(dueMs(bad)).toBeUndefined();
    expect(dueAtOf(now, '24h')).toBe('2026-11-25T08:00:00.000Z');
  });
});

describe('the Goal a hotfix opens', () => {
  it('is a bugfix Goal with one red-green criterion when it has a Given/When/Then, linked to the hotfix', () => {
    const spec = hotfixGoalDraft({
      id: 'GOAL-BUG-001',
      description: 'checkout total is wrong',
      link,
      now,
      report,
      check: { command: 'npm test' },
    }).spec;
    expect(spec.kind).toBe('bugfix');
    expect(spec.hotfixOf).toEqual(link);
    expect(spec.acceptance).toHaveLength(1);
  });
  it('waits as a sketch without one, and a bugfix Goal that is not a hotfix still needs exactly one criterion', () => {
    const sketch = hotfixGoalDraft({ id: 'GOAL-BUG-001', description: 'x', link, now }).spec;
    expect(sketch.acceptance).toHaveLength(0);
    expect(sketch.hotfixOf?.commit).toBe(commit);
    const plain = { ...sketch, hotfixOf: undefined };
    expect(() => parseGoalSpec(plain)).toThrow(/exactly one/);
    expect(() => parseGoalSpec({ ...sketch, kind: 'feature' })).toThrow(/hotfixOf belongs to a bugfix/);
  });
});

describe('a hotfix on the Goal', () => {
  it('is recorded by hotfix-accepted for the commit the Goal is linked to, and by no other', () => {
    const state = replay([drafted(), newEvent('GOAL-BUG-001', 'hotfix-accepted', accepted)]);
    expect(state.hotfix).toMatchObject({ commit, before, by: 'on-behalf', onBehalf: 'demo' });
    expect(() =>
      replay([drafted(), newEvent('GOAL-BUG-001', 'hotfix-accepted', { ...accepted, commit: 'c'.repeat(40) })]),
    ).toThrow(/linked/);
    expect(() =>
      replay([
        drafted(),
        newEvent('GOAL-BUG-001', 'hotfix-accepted', accepted),
        newEvent('GOAL-BUG-001', 'hotfix-accepted', accepted),
      ]),
    ).toThrow(/already accepted/);
  });
  it('keeps what L0 and L1 said, and the red layers are named for the inbox', () => {
    const state = replay([
      drafted(),
      newEvent('GOAL-BUG-001', 'hotfix-accepted', accepted),
      newEvent('GOAL-BUG-001', 'hotfix-gated', {
        commit,
        layers: [
          { part: 'app', layer: 'L0', tool: 'lint', status: 'pass' },
          { part: 'app', layer: 'L1', tool: 'unit', status: 'fail', note: 'exit 1' },
        ],
      }),
    ]);
    expect(redNote(state.hotfix!)).toBe('hotfix đỏ ở L1');
  });
  it('survives a revision of the Goal, which cannot add, drop or change the link', () => {
    const base = [drafted(), newEvent('GOAL-BUG-001', 'hotfix-accepted', accepted)];
    const sketch = replay(base).spec;
    const revised = {
      ...sketch,
      version: 2,
      acceptance: [
        {
          id: 'AC-1',
          text: 'x',
          requirementIds: ['R-1'],
          given: 'g',
          when: 'w',
          then: 't',
          checkIds: ['CHK-1'],
        },
      ],
      checks: [{ id: 'CHK-1', kind: 'command', command: 'npm test', expect: 'pass' }],
    };
    const after = replay([...base, newEvent('GOAL-BUG-001', 'goal-revised', parseGoalSpec(revised))]);
    expect(after.hotfix?.commit).toBe(commit);
    expect(after.spec.version).toBe(2);
    const unlinked = { ...revised, hotfixOf: undefined };
    expect(() => replay([...base, newEvent('GOAL-BUG-001', 'goal-revised', parseGoalSpec(unlinked))])).toThrow(
      /hotfix/,
    );
    expect(() =>
      replay([
        ...base,
        newEvent(
          'GOAL-BUG-001',
          'goal-revised',
          parseGoalSpec({ ...revised, hotfixOf: { ...link, dueAt: '2027-01-01T00:00:00.000Z' } }),
        ),
      ]),
    ).toThrow(/hotfix/);
  });
});

describe('where a hotfix stands', () => {
  const stateAt = (status: 'closed' | 'stopped' | 'open'): GoalState => ({
    ...replay([drafted(), newEvent('GOAL-BUG-001', 'hotfix-accepted', accepted)]),
    status: status === 'open' ? 'executing' : status,
  });
  it('is waiting until the deadline, overdue after it, proven when the Goal closed, abandoned when it was stopped', () => {
    expect(hotfixStatus(stateAt('open'), '2026-11-25T07:59:59.000Z')).toBe('waiting');
    expect(hotfixStatus(stateAt('open'), '2026-11-25T08:00:01.000Z')).toBe('overdue');
    expect(hotfixStatus(stateAt('closed'), '2027-01-01T00:00:00.000Z')).toBe('proven');
    expect(hotfixStatus(stateAt('stopped'), now)).toBe('abandoned');
  });
  it('counts every hotfix without evidence, a stopped one included', () => {
    const rows = hotfixRows([stateAt('open'), stateAt('closed'), stateAt('stopped')], now);
    expect(unprovenCount(rows)).toBe(2);
  });
});

describe('the delivery of a hotfix', () => {
  it('is red unless it contains the hotfix commit', () => {
    const hotfix = { ...accepted, by: 'human' as const };
    expect(hotfixCheck({ hotfix, contains: true }).status).toBe('pass');
    const red = hotfixCheck({ hotfix, contains: false });
    expect(red.status).toBe('fail');
    expect(red.reason).toContain(commit);
  });
});
