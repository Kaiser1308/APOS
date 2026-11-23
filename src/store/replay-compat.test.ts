import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLegacyGoal, LEGACY_EVENT_TYPES } from '../domain/legacy-events.js';
import { verifyChain } from './event-log.js';
import { ReadOnlyJournal } from './readonly-journal.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay');

/** Every Goal in these fixtures was recorded while APOS still dispatched agents, so each one carries orchestration events. */
const PINNED_LEGACY: Record<string, string[]> = {
  lead: ['GOAL-001'],
  'legacy-solo': ['GOAL-SMOKE-R', 'GOAL-SMOKE-V2'],
  'legacy-solo-v1': ['GOAL-SMOKE-V2'],
  'multi-wp': ['GOAL-001'],
};

describe('event log replay compatibility', () => {
  it('pins every fixture', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(Object.keys(PINNED_LEGACY).sort());
  });

  for (const name of readdirSync(FIXTURES)) {
    it(`replays ${name} to the pinned state`, async () => {
      const journal = new ReadOnlyJournal(join(FIXTURES, name));
      expect([...journal.failures]).toEqual([]);
      expect(journal.listGoals().length).toBeGreaterThan(0);
      await expect(JSON.stringify(journal.listGoals(), null, 2)).toMatchFileSnapshot(
        `./__snapshots__/replay/${name}.json`,
      );
    });

    it(`keeps the hash chain of ${name} intact and classifies its Goals`, () => {
      const dir = join(FIXTURES, name, 'events');
      const legacy: string[] = [];
      for (const file of readdirSync(dir).sort()) {
        const goalId = file.replace(/\.jsonl$/, '');
        const lines = readFileSync(join(dir, file), 'utf8').split('\n').slice(0, -1);
        const events = verifyChain(goalId, lines).map(line => line.event);
        if (isLegacyGoal(events)) legacy.push(goalId);
      }
      expect(legacy).toEqual(PINNED_LEGACY[name]);
    });
  }
});

describe('isLegacyGoal', () => {
  it('is true when any orchestration event is present', () => {
    expect(isLegacyGoal([{ type: 'goal-drafted' }, { type: 'lead-started' }])).toBe(true);
    expect(isLegacyGoal([{ type: 'controller-requested' }])).toBe(true);
  });
  it('is false for Goals that only carry assurance events', () => {
    expect(isLegacyGoal([{ type: 'goal-drafted' }, { type: 'goal-approved' }, { type: 'gate-recorded' }])).toBe(false);
    expect(isLegacyGoal([])).toBe(false);
  });
  it('covers the three controller request event names', () => {
    for (const type of ['controller-requested', 'controller-request-attempted', 'controller-request-settled'])
      expect(LEGACY_EVENT_TYPES.has(type)).toBe(true);
  });
});
