import { expect, it } from 'vitest';
import { leadBrief, leadWakeBrief, repairBrief } from './brief.js';

const base = { repoPath: 'C:/repo', goalId: 'GOAL-X', baseCommit: 'a'.repeat(40), idempotencyKey: 'k', digest: () => 'f'.repeat(64) };

it('tells the owner the budget left so it does not stop at partial work (seen live: stopped at 15 of 90 min)', () => {
  const brief = leadBrief({ ...base, goalVersion: 1, budget: { minutesLeft: 89.6, attemptsLeft: 2 } });
  expect(brief).toMatch(/about 90 min of wall time and 2 attempt\(s\) after this one/);
  expect(brief).toMatch(/do not stop at partial work/);
  expect(brief).not.toMatch(/\n/);
  expect(repairBrief({ goalId: 'GOAL-X', attempt: 2, finding: 'a\nb', idempotencyKey: 'k', repoPath: 'C:/repo', budget: { minutesLeft: 60, attemptsLeft: 1 } })).toMatch(/about 60 min .* 1 attempt/);
  expect(leadBrief({ ...base, goalVersion: 1 })).not.toMatch(/Budget left/);
});

it('has the Lead plan and, in Solo, deliver in the same turn, from its own worktree and base', () => {
  const brief = leadBrief({ ...base, goalVersion: 2 });
  expect(brief).toContain('GOAL-X: APOS Lead for Goal v2');
  expect(brief).toContain('lead commit GOAL-X');
  expect(brief).toMatch(/Solo: once lead commit is accepted you are the owner\. Keep going in this same turn/);
  expect(brief).toContain('.apos/goals/GOAL-X/evidence/solo-a1.md');
  expect(brief).toContain(`APOS base commit: ${'a'.repeat(40)}.`);
  expect(brief).toContain('apos-core: ffffffffffffffff');
  // The plan is recorded only after this worktree was cut, so it must not be cited at the base.
  expect(brief).not.toContain('execution.md');
});

it('wakes a Lead whose plan is not accepted yet with the Human decision, on its own terminal', () => {
  const brief = leadWakeBrief({ repoPath: 'C:/repo', goalId: 'GOAL-X', events: ['human: appetite raised to 60 min'], idempotencyKey: 'w1', phase: 'plan' });
  expect(brief).toContain('your plan is not accepted yet');
  expect(brief).toContain('(1) human: appetite raised to 60 min');
  expect(brief).toContain('lead commit GOAL-X');
  expect(leadWakeBrief({ repoPath: 'C:/repo', goalId: 'GOAL-X', events: ['e'], idempotencyKey: 'w2' })).toContain('for Multi-WP');
});
