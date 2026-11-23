#!/usr/bin/env node
// Runs one example Goal (examples/<name>) through the whole APOS v3 flow with the real binary and a real test runner:
//   node scripts/demo-goal.mjs <ts-orders|py-parking|ts-bug> [--keep] [--bin <path to cli.js>]
// It copies the example to a temp directory, `git init`s it, and drives APOS with the commands a Lead, a Tester, a Worker
// and a Reviewer would run. Every step prints what APOS said and checks the exit code it expected; a surprise exits 1.
// A machine without a tool the example needs stops at once with exit 2 and says which (it never reports a pass it did not see).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const binAt = args.indexOf('--bin');
const bin = resolve(binAt >= 0 ? args[binAt + 1] : join(root, 'dist', 'cli.js'));
const name = args.find((arg, index) => !arg.startsWith('--') && (binAt < 0 || index !== binAt + 1));
const source = name ? join(root, 'examples', name) : undefined;

const usage = (message, code) => {
  console.error(message);
  process.exit(code);
};
const hasStory = source && ['goal.json', 'bug.json'].some(file => existsSync(join(source, file)));
if (!hasStory) usage('usage: node scripts/demo-goal.mjs <ts-orders|py-parking|ts-bug> [--keep] [--bin <cli.js>]', 2);
if (!existsSync(bin)) usage(`demo: ${bin} does not exist: run \`npm run build\` first`, 2);

const demo = JSON.parse(readFileSync(join(source, 'demo.json'), 'utf8'));
// On Windows `npx` is `npx.cmd`, which node starts only through a shell.
const works = (command, ...argv) =>
  spawnSync(command, argv, { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0;

// What the example needs on this machine. Python is `python` on one system and `python3` on another.
const missing = [];
if (!works('git', '--version')) missing.push('git');
let python = 'python';
for (const tool of demo.tools) {
  if (tool === 'python') {
    python = works('python', '--version') ? 'python' : works('python3', '--version') ? 'python3' : '';
    if (!python) missing.push('python (python or python3)');
  } else if (!works(tool, '--version')) missing.push(tool);
}
const vitest = join(root, 'node_modules', '.bin', 'vitest');
if (demo.tools.includes('npx') && !existsSync(vitest)) missing.push('vitest (run `npm ci` in the APOS repo)');
if (missing.length) {
  console.error(
    `demo: cannot run ${name}: this machine lacks ${missing.join(', ')}. Nothing was run, so nothing passed.`,
  );
  process.exit(2);
}

const temp = mkdtempSync(join(tmpdir(), `apos-demo-${name}-`));
const repo = join(temp, 'repo');
const home = join(temp, 'home');
const artifacts = join(temp, 'artifacts');
const work = join(temp, 'work');
for (const dir of [home, artifacts, work]) mkdirSync(dir);
cpSync(join(source, 'repo'), repo, { recursive: true });

const shown = text =>
  text.replaceAll(repo, '<repo>').replaceAll(temp, '<tmp>').replaceAll(root, '<apos>').replace(/\r\n/g, '\n').trimEnd();
const git = (...argv) => {
  const done = spawnSync(
    'git',
    ['-C', repo, '-c', 'user.name=demo', '-c', 'user.email=demo@local.invalid', '-c', 'core.autocrlf=false', ...argv],
    { encoding: 'utf8' },
  );
  if (done.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${done.stderr}`);
  return done.stdout.trim();
};
const commit = message => {
  git('add', '-A');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
};

let failed;
/** Runs `apos <args>`, prints it and what it said, and checks the exit code. */
function apos(expected, note, ...argv) {
  const done = spawnSync(process.execPath, [bin, '--repo', repo, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, APOS_HOME: home, APOS_ARTIFACTS: artifacts, NODE_NO_WARNINGS: '1' },
  });
  const code = done.status ?? 1;
  const shortArgs = argv.map(arg => (/^[0-9a-f]{40}$/.test(arg) ? arg.slice(0, 10) : arg));
  console.log(`\n# ${note}\n$ apos ${shortArgs.join(' ')}  # exit ${code}`);
  const text = shown(`${done.stdout}${done.stderr}`);
  if (text) console.log(text);
  if (code !== expected) {
    failed = `expected exit ${expected}, got ${code}: apos ${shortArgs.join(' ')}`;
    throw new Error(failed);
  }
  return text;
}
const expectText = (text, wanted) => {
  if (!text.includes(wanted)) {
    failed = `the output should contain "${wanted}"`;
    throw new Error(failed);
  }
};
const human = ['--on-behalf', 'demo'];

/**
 * The bug story: one command opens the Goal, one the Human approves, and the usual flow follows. The Tester's test
 * reproduces the bug on the code as it is (red, locked); the Worker's fix turns it green; the Human closes.
 */
function bugStory(base) {
  const bug = JSON.parse(readFileSync(join(source, 'bug.json'), 'utf8'));
  const id = 'GOAL-BUG-001';
  expectText(
    apos(
      0,
      'the PM opens a bugfix Goal from what was seen',
      'bug',
      'open',
      bug.description,
      '--given',
      bug.given,
      '--when',
      bug.when,
      '--then',
      bug.then,
      '--repro-hint',
      bug.reproHint,
    ),
    `apos bug approve ${id}`,
  );
  expectText(apos(0, 'it waits for the Human in the inbox', 'inbox'), `apos bug approve ${id}`);
  apos(0, 'the Human approves, sets the default appetite and selects, in one command', 'bug', 'approve', id, ...human);
  apos(0, 'the Lead plans it: one Solo package, base is the current HEAD', 'lead', 'propose', '--bugfix', '--goal', id);
  apos(0, 'the Lead commits the plan: the Goal waits for the reproduction test', 'lead', 'commit', id);

  const step = (branch, parent, patch) => {
    git('checkout', '-q', '-B', branch, parent);
    git('apply', '--index', join(source, 'steps', `${patch}.patch`));
    return commit(patch);
  };
  const green = step('tester-green', 'main', '00-green-test');
  expectText(
    apos(
      1,
      'a Tester hands over a test that is green on the bug: it does not reproduce it, so it is refused',
      'tests',
      'submit',
      id,
      '--commit',
      green,
    ),
    'test không tái hiện lỗi',
  );
  const edit = step('tester-edit', 'main', '00b-code-edit');
  expectText(
    apos(
      1,
      'a Tester who also edits the code is refused: only tests may change, so red here is red on the base',
      'tests',
      'submit',
      id,
      '--commit',
      edit,
    ),
    'the Tester adds tests only',
  );
  const repro = step('tester', 'main', '01-repro-test');
  apos(
    0,
    'the Tester hands over a test that fails on the bug as it is (only tests changed): it is locked',
    'tests',
    'submit',
    id,
    '--commit',
    repro,
  );
  const fix = step('worker', repro, '02-fix');
  expectText(
    apos(
      0,
      'the Worker delivers the fix: the locked test is green, the Goal is verified',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      fix,
    ),
    'verified',
  );
  apos(0, 'the Human closes the Goal on the commit that passed the gate', 'outcome', 'close', id, ...human);
  expectText(
    apos(0, 'the assurance table says which test reproduced the bug, red before and green after', 'goal', 'show', id),
    'lỗi được tái hiện bằng test',
  );
}

try {
  console.log(`demo ${name}: working in <tmp> (a temp directory; --keep leaves it)`);
  if (demo.tools.includes('npx'))
    symlinkSync(
      join(root, 'node_modules'),
      join(repo, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  git('init', '-q', '-b', 'main');
  commit('the project today');

  apos(0, 'init the project', 'init');
  apos(0, 'draft the setup from the catalog', 'setup', 'draft');
  // The machine has no linter or integration of its own to probe: keep the tools the example uses, add its benchmark.
  const setupFile = join(repo, '.apos', 'project.yaml');
  const setup = parse(readFileSync(setupFile, 'utf8'));
  const app = setup.parts.app;
  delete app.layers.L0;
  if (demo.bench) {
    const benchTool = { ...demo.bench, command: demo.bench.command.replace(/^python /, `${python} `) };
    app.layers.L5 = [benchTool];
  } else delete app.layers.L5;
  writeFileSync(setupFile, stringify(setup));
  const base = commit('setup');
  apos(0, 'probe every tool of the setup in a clean worktree', 'setup', 'probe', '--commit', base);
  apos(0, 'the Human approves the probed setup', 'setup', 'approve', '--commit', base, ...human);
  if (demo.story === 'bugfix') bugStory(base);
  else {
    apos(
      0,
      'the PM drafts the Goal from the brief',
      'goal',
      'create',
      '--file',
      join(source, 'goal.json'),
      '--source',
      join(source, 'brief.md'),
    );
    apos(
      0,
      'the Human approves the Goal and its appetite',
      'goal',
      'approve',
      'GOAL-001',
      '--size',
      'M',
      '--max-minutes',
      '240',
      '--max-attempts',
      '5',
      ...human,
    );
    apos(0, 'the Human selects it', 'goal', 'select', 'GOAL-001', ...human);
    const plan = JSON.parse(readFileSync(join(source, 'plan.json'), 'utf8'));
    const planFile = join(work, 'plan.json');
    writeFileSync(planFile, JSON.stringify({ ...plan, baseCommit: base }));
    apos(0, 'the Lead proposes a Solo plan', 'lead', 'propose', '--file', planFile);
    apos(0, 'the Lead commits the plan: the Goal waits for locked tests', 'lead', 'commit', 'GOAL-001');

    /** A branch from `parent` with the patch of `step` applied and committed: what that person would hand over. */
    const step = (branch, parent, patch) => {
      git('checkout', '-q', '-B', branch, parent);
      git('apply', '--index', join(source, 'steps', `${patch}.patch`));
      return commit(patch);
    };
    const locked = step('tester', 'main', '01-tests-and-stub');
    apos(
      0,
      'the Tester hands over acceptance tests and a stub: red for the right reason, so they are locked',
      'tests',
      'submit',
      'GOAL-001',
      '--commit',
      locked,
    );

    const edit = step('worker-edits-test', locked, '02-locked-test-edit');
    expectText(
      apos(
        1,
        'a Worker makes the test pass by weakening it: red',
        'package',
        'submit',
        'GOAL-001',
        'WP-MAIN',
        '--commit',
        edit,
      ),
      'locked test modified',
    );
    const buggy = step('worker-buggy', locked, '03-buggy-code');
    expectText(
      apos(
        1,
        'a Worker delivers code with a bug: the locked test is red',
        'package',
        'submit',
        'GOAL-001',
        'WP-MAIN',
        '--commit',
        buggy,
      ),
      'APOS-LOCKED fail',
    );
    const good = step('worker', locked, '04-correct-code');
    expectText(
      apos(
        0,
        'a Worker delivers code that meets every acceptance test: green, the Goal is verified',
        'package',
        'submit',
        'GOAL-001',
        'WP-MAIN',
        '--commit',
        good,
      ),
      'verified',
    );

    const review = step('reviewer', good, '05-review-test');
    expectText(
      apos(
        1,
        'a Reviewer finds what the tests missed and says it with a test: it is red, so the package is blocked',
        'review',
        'block',
        'GOAL-001',
        'WP-MAIN',
        '--commit',
        review,
        '--by',
        'reviewer',
      ),
      'blocked by review',
    );
    const fixed = step('worker-fix', review, '06-final-fix');
    expectText(
      apos(
        0,
        'the final fix, built on the review commit: its test is locked and passes',
        'package',
        'submit',
        'GOAL-001',
        'WP-MAIN',
        '--commit',
        fixed,
      ),
      'verified',
    );

    expectText(
      apos(
        0,
        'the Human closes the Goal: the close-stage layers (the benchmark among them) run on the verified commit',
        'outcome',
        'close',
        'GOAL-001',
        ...human,
      ),
      'Close-stage layers green',
    );
    apos(0, 'the assurance table: what the machine proved, and what it did not', 'goal', 'show', 'GOAL-001');
  }
  console.log(`\ndemo ${name}: every step ended as expected.`);
} catch (error) {
  console.error(`\ndemo ${name} FAILED: ${failed ?? (error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
} finally {
  // Every apos command was its own process, so no journal is open: the directory can go.
  if (keep) console.log(`kept: ${temp}`);
  else rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
