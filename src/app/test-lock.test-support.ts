import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { newEvent } from './events.js';
import { initProject } from './init-project.js';
import { ToolRunner } from './layer-runner.js';
import { TestLockService } from './test-lock.js';
import { AssuranceService } from './assurance-service.js';
import { GateService } from './gate-service.js';
import { GitCommitInspector } from './integration.js';
import { PackageService } from './package-service.js';
import { loadPinnedSetup } from './pinned-setup.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { setupSha256 } from '../domain/project-setup.js';
import { ProjectJournal } from '../store/journal.js';
import { approval, proposal, sourceText, spec } from '../domain/fixtures.test-support.js';
import type { GoalSpec } from '../domain/contracts.js';
import type { GoalState } from '../domain/transitions.js';

/**
 * A fake test tool for the lock and gate tests. It reads `*.t` files under a directory: `case <name> <kind> [arg]` with
 * kind `pass`, `fail`, `skip`, `load` (a load error), `typo` (an error that is not "not implemented"), `needs <feature>`
 * (fails with NotImplementedError until `src/impl.txt` mentions the feature), `needs-err <feature>` (the same as an error) or
 * `gone <feature>` (a test of absence: fails with an AssertionError while `src/impl.txt` still mentions the feature).
 */
export const RUNNER = `
const fs = require('fs'), path = require('path');
const [out, dir] = process.argv.slice(2);
const impl = fs.existsSync('src/impl.txt') ? fs.readFileSync('src/impl.txt', 'utf8') : '';
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
let cases = '';
function read(file) {
  const cls = file.replace(/\\\\/g, '/').replace(/\\.t$/, '').replace(/\\//g, '.');
  for (const line of fs.readFileSync(file, 'utf8').split(/\\r?\\n/)) {
    const m = /^case (\\S+) (\\S+)(?: (.*))?$/.exec(line);
    if (!m) continue;
    const [, name, kind, arg] = m;
    let inner = '';
    if (kind === 'fail') inner = '<failure message="AssertionError: ' + esc(arg) + '"/>';
    else if (kind === 'skip') inner = '<skipped/>';
    else if (kind === 'load') inner = '<error message="ImportError while importing test module"/>';
    else if (kind === 'typo') inner = '<error message="NameError: nope"/>';
    else if (kind === 'needs' && !impl.includes(arg)) inner = '<failure message="NotImplementedError: ' + esc(arg) + '"/>';
    else if (kind === 'gone' && impl.includes(arg)) inner = '<failure message="AssertionError: ' + esc(arg) + ' is still there"/>';
    else if (kind === 'needs-err' && !impl.includes(arg)) inner = '<error message="NotImplementedError: ' + esc(arg) + '"/>';
    cases += '<testcase classname="' + cls + '" name="' + name + '">' + inner + '</testcase>';
  }
}
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.t')) read(p);
  }
}
if (fs.existsSync(dir)) walk(dir);
if (fs.existsSync('tests/infra.cfg') && fs.readFileSync('tests/infra.cfg', 'utf8').includes('swallow'))
  cases = cases.replace(/<(failure|error) [^>]*\\/>/g, '');
fs.writeFileSync(out, '<testsuite name="s">' + cases + '</testsuite>');
`;

export const setupDocument = {
  schemaVersion: 2,
  parts: {
    app: {
      root: '.',
      stack: 'fake',
      layers: {
        L1: [{ id: 'unit', command: 'node runner.js {report} tests/unit', format: 'junit' }],
        L2: [{ id: 'acceptance', command: 'node runner.js {report} tests/acceptance', format: 'junit' }],
      },
      needsHuman: ['pyproject.toml'],
      forbid: ['@skip'],
      tests: {
        paths: ['tests/**'],
        infra: ['tests/infra.cfg'],
        assertPatterns: ['^case\\b'],
        notImplementedPatterns: ['NotImplementedError'],
        loadErrorPatterns: ['ImportError'],
      },
    },
  },
};

const dirs: string[] = [];
const closers: (() => void)[] = [];
/** Closes the journals first (an open SQLite file cannot be removed on Windows), then removes the directories. */
export const cleanProjects = () => {
  for (const close of closers.splice(0))
    try {
      close();
    } catch {
      /* already closed */
    }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
};
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

export const ids = {
  add: 'tests.acceptance.calc::add',
  sub: 'tests.acceptance.calc::sub',
  unit: 'tests.unit.u::one',
};
export const mapFor = (goalId: string, testIds: string[] = [ids.add]) =>
  JSON.stringify([{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds }]);

/** A repo with a fake test tool, an approved setup pinned by a Goal that is `testing`, and a service to lock tests. */
export async function testingProject(
  options: {
    goal?: GoalSpec;
    setup?: object;
    files?: Record<string, string>;
    paths?: string[];
    /** Extra fields of the plan (`layers`, ...). */
    plan?: object;
    packages?: object[];
  } = {},
) {
  const dir = temp('apos-lock-repo-');
  const home = temp('apos-lock-home-');
  const artifacts = temp('apos-lock-art-');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', ...args], {
      encoding: 'utf8',
    }).trim();
  const write = (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
  };
  /** Commits on the current branch and returns the sha. */
  const commit = (files: Record<string, string | null>, message = 'work') => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) rmSync(join(dir, name), { force: true });
      else write({ [name]: content });
    }
    git('add', '-A');
    git('commit', '-qm', message, '--allow-empty');
    return git('rev-parse', 'HEAD');
  };
  await initProject(dir);
  const setupText = jsonCodec.stringify(options.setup ?? setupDocument);
  const base = commit(
    {
      'runner.js': RUNNER,
      '.apos/project.yaml': setupText,
      'src/impl.txt': '',
      'tests/unit/u.t': 'case one pass\n',
      'tests/infra.cfg': 'plain\n',
      ...options.files,
    },
    'base',
  );
  const { journal, close } = ProjectJournal.open(dir, home, newEvent);
  closers.push(close);
  const sha256 = setupSha256(setupText);
  const at = new Date().toISOString();
  journal.appendProjectEvent({
    id: 'P1',
    type: 'setup-probed',
    at,
    data: { sha256, commit: base, ok: true, results: [] },
  });
  journal.appendProjectEvent({
    id: 'A1',
    type: 'setup-approved',
    at,
    data: { sha256, commit: base, version: 1, confirmation: { by: 'human' } },
  });
  const goal = options.goal ?? spec;
  journal.appendWithSource(newEvent(goal.id, 'goal-drafted', goal), sourceText);
  journal.append(newEvent(goal.id, 'goal-approved', { ...approval, setupVersion: 1 }));
  journal.append(newEvent(goal.id, 'goal-selected'));
  journal.append(
    newEvent(goal.id, 'proposal-drafted', {
      ...proposal,
      rationale: 'one owner',
      baseCommit: base,
      acceptanceMapping: goal.acceptance.map(item => ({ acceptanceId: item.id, verification: 'test' })),
      paths: options.paths ?? ['src/**', 'tests/unit/**'],
      stubPaths: ['src/stub.txt'],
      ...options.plan,
    }),
  );
  for (const item of options.packages ?? []) journal.append(newEvent(goal.id, 'package-added', item));
  journal.append(newEvent(goal.id, 'proposal-approved', { by: 'lead', testing: true }));
  const runner = new ToolRunner(dir, { artifactRoot: artifacts });
  const loadSetup = (state: GoalState) => loadPinnedSetup(dir, journal.setupHistory(), state.setupVersion, jsonCodec)!;
  const service = new TestLockService(journal, { repoPath: dir, runner, loadSetup });
  const state = () => journal.getGoal(goal.id)!;
  return {
    dir,
    home,
    artifacts,
    git,
    commit,
    base,
    journal,
    close,
    service,
    loadSetup,
    state,
    goalId: goal.id,
    runner,
  };
}

/** The usual good tester commit: one acceptance test that is red until `add` is implemented. */
export const goodTests = (goalId: string): Record<string, string> => ({
  'tests/acceptance/calc.t': 'case add needs add\n',
  'src/stub.txt': 'stub\n',
  [`.apos/goals/${goalId}/tests.json`]: mapFor(goalId),
});

/** A project whose tests are locked on top of the base: ready for a worker commit to be gated. */
export async function lockedProject(options: Parameters<typeof testingProject>[0] = {}) {
  const goal = options.goal ?? { ...spec, checks: [{ ...spec.checks[0]!, command: 'node -e "process.exit(0)"' }] };
  const p = await testingProject({ ...options, goal });
  const lockCommit = p.commit(goodTests(p.goalId), 'tests');
  const locked = await p.service.submit(p.goalId, lockCommit, 'tester');
  if (!locked.ok) throw new Error(`fixture tests were refused: ${locked.problems.join('; ')}`);
  const assurance = new AssuranceService({
    repo: p.dir,
    runner: p.runner,
    inspector: new GitCommitInspector(),
    loadSetup: p.loadSetup,
  });
  const gate = new GateService(p.journal, { artifactRoot: p.artifacts, assurance });
  const packages = new PackageService(p.journal, { gate, repoPath: p.dir });
  const submit = (commit: string, packageId = 'WP-MAIN') => packages.submit(p.goalId, packageId, commit, 'worker');
  return { ...p, lockCommit, gate, packages, assurance, submit };
}
