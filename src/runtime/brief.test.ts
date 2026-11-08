import { expect, it } from 'vitest';
import { repairBrief, soloBrief } from './brief.js';

const base = { repoPath: 'C:/repo', goalId: 'GOAL-X', baseCommit: 'a'.repeat(40), idempotencyKey: 'k', digest: () => 'f'.repeat(64) };

it('tells the owner the budget left so it does not stop at partial work (seen live: stopped at 15 of 90 min)', () => {
  const brief = soloBrief({ ...base, attempt: 1, budget: { minutesLeft: 89.6, attemptsLeft: 2 } });
  expect(brief).toMatch(/about 90 min of wall time and 2 attempt\(s\) after this one/);
  expect(brief).toMatch(/do not stop at partial work/);
  expect(brief).not.toMatch(/\n/);
  expect(repairBrief({ goalId: 'GOAL-X', attempt: 2, finding: 'a\nb', idempotencyKey: 'k', repoPath: 'C:/repo', budget: { minutesLeft: 60, attemptsLeft: 1 } })).toMatch(/about 60 min .* 1 attempt/);
  expect(soloBrief({ ...base, attempt: 1 })).not.toMatch(/Budget left/);
});
