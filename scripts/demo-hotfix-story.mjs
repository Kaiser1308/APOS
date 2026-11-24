// The story of examples/ts-hotfix, told through the real binary (see scripts/demo-goal.mjs, which calls this):
// production is on fire, the Human lets a fix through now, and APOS does not forget: it records the hotfix, opens the
// bugfix Goal that owes the evidence, shows it in the inbox, turns red when the deadline passes, and asks for the proof
// (a test red on the commit before the hotfix, green on a delivery that contains it). The clock is set with APOS_NOW so
// "a day later" does not take a day; only the commands that read a deadline look at it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const T0 = '2026-11-24T08:00:00Z';
const T1 = '2026-11-25T09:00:00Z';

export function hotfixStory({ apos, git, commit, expectText, human, source }) {
  const brief = JSON.parse(readFileSync(join(source, 'hotfix.json'), 'utf8'));
  const id = 'GOAL-BUG-001';
  const at = (time, run) => {
    process.env.APOS_NOW = time;
    try {
      return run();
    } finally {
      delete process.env.APOS_NOW;
    }
  };
  const before = git('rev-parse', 'HEAD');
  git('apply', '--index', join(source, 'steps', '00-hotfix.patch'));
  const hotfix = commit('hotfix: FREE0 takes nothing off');
  const accept = (expected, note, ...extra) =>
    at(T0, () =>
      apos(
        expected,
        note,
        'hotfix',
        brief.description,
        '--commit',
        hotfix,
        '--due',
        brief.due,
        '--given',
        brief.given,
        '--when',
        brief.when,
        '--then',
        brief.then,
        ...extra,
      ),
    );

  expectText(
    accept(1, 'an agent with no terminal and no --on-behalf runs apos hotfix: it is a Human command, so it is refused'),
    'Human decision',
  );
  expectText(apos(0, 'nothing was recorded', 'hotfix', 'list'), 'No hotfix yet.');
  expectText(
    accept(
      0,
      'the Human lets the hotfix through (the demo says so with --on-behalf): recorded, L1 runs on it, the Goal is opened and approved',
      ...human,
    ),
    `Goal ${id}`,
  );
  expectText(
    at(T0, () =>
      apos(0, 'the inbox shows the hotfix as waiting for its evidence, with the absolute deadline', 'inbox'),
    ),
    'hotfix chưa có bằng chứng: 1',
  );
  expectText(
    at(T1, () => apos(0, 'a day later the hotfix is overdue and the inbox says so, in red', 'inbox')),
    'quá hạn 2026-11-25T08:00:00.000Z, chưa có bằng chứng',
  );
  apos(
    0,
    'the Lead plans it: base is the commit before the hotfix, paths are the files the hotfix changed',
    'lead',
    'propose',
    '--bugfix',
    '--goal',
    id,
  );
  apos(0, 'the Lead commits the plan: the Goal waits for the reproduction test', 'lead', 'commit', id);

  const step = (branch, parent, patch) => {
    git('checkout', '-q', '-B', branch, parent);
    git('apply', '--index', join(source, 'steps', `${patch}.patch`));
    return commit(patch);
  };
  const green = step('tester-green', before, '00-green-test');
  expectText(
    apos(
      1,
      'a Tester hands over a test that is green on the commit before the hotfix: it does not reproduce the bug, so it is refused',
      'tests',
      'submit',
      id,
      '--commit',
      green,
    ),
    'test không tái hiện lỗi',
  );
  const repro = step('tester', before, '01-repro-test');
  apos(
    0,
    'the Tester hands over a test that is red on the commit before the hotfix: it is locked',
    'tests',
    'submit',
    id,
    '--commit',
    repro,
  );
  const own = step('worker-own-fix', repro, '02-own-fix');
  expectText(
    apos(
      1,
      'a Worker delivers a fix of their own instead of the hotfix: the evidence is not about the code in production, so it is red',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      own,
    ),
    'APOS-HOTFIX fail',
  );
  git('checkout', '-q', '-B', 'delivery', repro);
  git('merge', '-q', '--no-edit', hotfix);
  const delivery = git('rev-parse', 'HEAD');
  expectText(
    apos(
      0,
      'the delivery is the Tester’s commit with the hotfix merged in: the locked test is green on it, the Goal is verified',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      delivery,
    ),
    'verified',
  );
  apos(0, 'the Human closes the Goal on the commit that passed the gate', 'outcome', 'close', id, ...human);
  expectText(
    at(T1, () => apos(0, 'every hotfix, with its state', 'hotfix', 'list')),
    'có bằng chứng',
  );
  expectText(
    at(T1, () =>
      apos(
        0,
        'the table says who let the hotfix through and which test is red before it and green with it',
        'goal',
        'show',
        id,
      ),
    ),
    'chấp nhận khẩn cấp bởi',
  );
}
