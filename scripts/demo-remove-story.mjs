// The story of examples/py-remove, told through the real binary (see scripts/demo-goal.mjs, which calls this):
// a shop drops its coupons. The Goal says which old tests go (two of them), the Tester locks a test that says coupons
// are gone (red while they are there), and the gate lets exactly those two tests disappear: one more is red, one
// forgotten is red, the delivery that removes the feature and the two tests is green.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function removalStory({ apos, git, commit, expectText, human, source, work, base }) {
  const id = 'GOAL-001';
  /** A branch from `parent` with the patch of `step` applied and committed: what that person would hand over. */
  const step = (branch, parent, patch) => {
    git('checkout', '-q', '-B', branch, parent);
    git('apply', '--index', join(source, 'steps', `${patch}.patch`));
    return commit(patch);
  };

  apos(
    0,
    'the PM drafts the Goal: one criterion, "coupons are gone", that names the two old tests that go with them',
    'goal',
    'create',
    '--file',
    join(source, 'goal.json'),
    '--source',
    join(source, 'brief.md'),
  );
  expectText(
    apos(
      0,
      'the Human approves: before confirming they are shown the tests the Goal will remove, found on the repo as it is',
      'goal',
      'approve',
      id,
      '--size',
      'S',
      '--max-minutes',
      '60',
      '--max-attempts',
      '5',
      ...human,
    ),
    'will remove these tests, and only these',
  );
  apos(0, 'the Human selects it', 'goal', 'select', id, ...human);
  const plan = JSON.parse(readFileSync(join(source, 'plan.json'), 'utf8'));
  const planFile = join(work, 'plan.json');
  writeFileSync(planFile, JSON.stringify({ ...plan, baseCommit: base }));
  apos(0, 'the Lead proposes a Solo plan', 'lead', 'propose', '--file', planFile);
  apos(0, 'the Lead commits the plan: the Goal waits for the test that says coupons are gone', 'lead', 'commit', id);

  const locked = step('tester', 'main', '01-absence-test');
  apos(
    0,
    'the Tester hands over two tests of absence (total() takes no coupon, the cart has no apply_coupon): red while coupons exist, so they are locked',
    'tests',
    'submit',
    id,
    '--commit',
    locked,
  );

  const extra = step('worker-too-much', locked, '02-removes-one-too-many');
  expectText(
    apos(
      1,
      'a Worker removes coupons and also deletes a test nobody declared: red, and it names the test',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      extra,
    ),
    'test missing: app.L1::tests.test_cart::test_an_empty_cart_totals_zero',
  );
  const forgot = step('worker-forgets', locked, '03-keeps-a-declared-test');
  expectText(
    apos(
      1,
      'a Worker removes coupons but keeps one of the two declared tests: red, "declared removed but still there"',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      forgot,
    ),
    'declared removed but still there: app.L1::tests.test_coupons::test_an_unknown_coupon_is_refused',
  );
  const good = step('worker', locked, '04-removal');
  expectText(
    apos(
      0,
      'a Worker removes coupons and exactly the two declared tests: the test of absence is green, no other test is lost',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      good,
    ),
    'verified',
  );
  apos(0, 'the Human closes the Goal on the commit that passed the gate', 'outcome', 'close', id, ...human);
  expectText(
    apos(
      0,
      'the assurance table says which test proved the feature gone and how many old tests went',
      'goal',
      'show',
      id,
    ),
    'xoá đúng 2 test đã khai',
  );
}
