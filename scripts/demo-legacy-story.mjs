// The story of examples/py-legacy, told through the real binary (see scripts/demo-goal.mjs, which calls this):
// a repo with no tests is approved as low assurance, a characterize Goal locks what the code does today, and a refactor
// may only touch what is captured, with every captured test green before and after.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function legacyStory({ apos, git, commit, expectText, human, source, work, base }) {
  const step = (branch, parent, patch) => {
    git('checkout', '-q', '-B', branch, parent);
    git('apply', '--index', join(source, 'steps', `${patch}.patch`));
    return commit(patch);
  };
  const goalArgs = (file, brief) => ['--file', join(source, file), '--source', join(source, brief)];

  expectText(
    apos(
      0,
      'the probe runs every tool (the setup keeps only L2, where the captured tests go): the repo has no tests, and the tool says so',
      'setup',
      'probe',
      '--commit',
      base,
    ),
    'no tests',
  );
  expectText(
    apos(
      1,
      'the Human approves without saying so: refused, there is no baseline',
      'setup',
      'approve',
      '--commit',
      base,
      ...human,
    ),
    '--baseline-missing',
  );
  expectText(
    apos(
      0,
      'the Human accepts a repo with no tests, knowingly: every Goal on this setup is labelled low assurance',
      'setup',
      'approve',
      '--commit',
      base,
      '--baseline-missing',
      ...human,
    ),
    'BẢO ĐẢM THẤP',
  );

  // Goal 1: capture what pricing.py does today.
  apos(
    0,
    'the PM drafts a characterize Goal: the behaviour of pricing.py as it is, odd corners included',
    'goal',
    'create',
    ...goalArgs('characterize.json', 'brief.md'),
    '--kind',
    'characterize',
    '--covers',
    'pricing.py',
  );
  apos(
    0,
    'the Human approves it, and with it the code it covers (gate A)',
    'goal',
    'approve',
    'GOAL-001',
    '--size',
    'S',
    '--max-minutes',
    '60',
    '--max-attempts',
    '3',
    ...human,
  );
  apos(0, 'the Human selects it', 'goal', 'select', 'GOAL-001', ...human);
  apos(0, 'the Lead plans it: one Solo package, tests only', 'lead', 'propose', '--characterize', '--goal', 'GOAL-001');
  apos(0, 'the Lead commits the plan: the Goal waits for the tests', 'lead', 'commit', 'GOAL-001');
  const wrong = step('tester-wrong', 'main', '01-wrong-capture');
  expectText(
    apos(
      1,
      "a Tester writes what they think FREE0 should do: red on today's code, refused",
      'tests',
      'submit',
      'GOAL-001',
      '--commit',
      wrong,
    ),
    'chụp hành vi phải xanh trên code như hiện tại',
  );
  const capture = step('tester', 'main', '02-capture');
  apos(
    0,
    'the Tester writes what the code does today: green twice, so it is locked',
    'tests',
    'submit',
    'GOAL-001',
    '--commit',
    capture,
  );
  expectText(
    apos(
      0,
      'no code to write: the Lead submits the commit that locked the tests',
      'package',
      'submit',
      'GOAL-001',
      'WP-MAIN',
      '--commit',
      capture,
    ),
    'verified',
  );
  apos(0, 'the Human closes the Goal', 'outcome', 'close', 'GOAL-001', ...human);
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', capture);
  expectText(
    apos(0, 'the table opens with the warning, and says what was captured', 'goal', 'show', 'GOAL-001'),
    'BẢO ĐẢM THẤP: repo chưa có test nền',
  );

  // Goal 2: tidy pricing.py, held to what Goal 1 captured.
  apos(
    0,
    'the PM drafts a refactor Goal; its paths are every module',
    'goal',
    'create',
    ...goalArgs('refactor.json', 'refactor-brief.md'),
  );
  expectText(
    apos(
      1,
      'the Human cannot approve it: shipping.py is not captured by any closed Goal',
      'goal',
      'approve',
      'GOAL-002',
      '--size',
      'M',
      '--max-minutes',
      '120',
      '--max-attempts',
      '3',
      ...human,
    ),
    'shipping.py',
  );
  apos(
    0,
    'the PM narrows the paths to pricing.py',
    'goal',
    'revise',
    ...goalArgs('refactor-v2.json', 'refactor-brief.md'),
  );
  apos(
    0,
    'the Human approves it: every file it reaches is captured',
    'goal',
    'approve',
    'GOAL-002',
    '--size',
    'M',
    '--max-minutes',
    '120',
    '--max-attempts',
    '3',
    ...human,
  );
  apos(0, 'the Human selects it', 'goal', 'select', 'GOAL-002', ...human);
  const plan = JSON.parse(readFileSync(join(source, 'refactor-plan.json'), 'utf8'));
  const planFile = join(work, 'refactor-plan.json');
  writeFileSync(planFile, JSON.stringify({ ...plan, baseCommit: git('rev-parse', 'main') }));
  apos(0, 'the Lead plans it on a base that holds the captured tests', 'lead', 'propose', '--file', planFile);
  apos(0, 'the Lead commits the plan', 'lead', 'commit', 'GOAL-002');
  const broken = step('worker-breaks', 'main', '03-refactor-breaks');
  expectText(
    apos(
      1,
      'a refactor that "fixes" FREE0 changes behaviour: the captured test is red',
      'package',
      'submit',
      'GOAL-002',
      'WP-MAIN',
      '--commit',
      broken,
    ),
    'APOS-CHARACTERIZED fail',
  );
  const tidy = step('worker', 'main', '04-refactor');
  expectText(
    apos(
      0,
      'a refactor that only restructures: every captured test is green, the Goal is verified',
      'package',
      'submit',
      'GOAL-002',
      'WP-MAIN',
      '--commit',
      tidy,
    ),
    'verified',
  );
  expectText(
    apos(
      0,
      'the Human closes it: the captured tests run again at the close stage',
      'outcome',
      'close',
      'GOAL-002',
      ...human,
    ),
    'Close-stage layers green',
  );
  expectText(
    apos(
      0,
      'the table says how many tests were kept, from which Goal, green before and after',
      'goal',
      'show',
      'GOAL-002',
    ),
    'giữ nguyên hành vi: 4 test chụp từ GOAL-001',
  );
}
