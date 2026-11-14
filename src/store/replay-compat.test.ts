import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ReadOnlyJournal } from './readonly-journal.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay');

describe('event log replay compatibility', () => {
  for (const name of readdirSync(FIXTURES)) {
    it(`replays ${name} to the pinned state`, async () => {
      const journal = new ReadOnlyJournal(join(FIXTURES, name));
      expect([...journal.failures]).toEqual([]);
      expect(journal.listGoals().length).toBeGreaterThan(0);
      await expect(JSON.stringify(journal.listGoals(), null, 2)).toMatchFileSnapshot(
        `./__snapshots__/replay/${name}.json`,
      );
    });
  }
});
