import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { spec as baseSpec, proposal, sourceText } from '../domain/fixtures.test-support.js';
import type { GoalSpec } from '../domain/contracts.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import { OrcaRefused } from '../runtime/orca/exec.js';
import {
  CORE_SKILL,
  activationLine,
  committedFileDigest,
  packageReportPath,
  reviewResultPath,
} from '../runtime/brief.js';
import { ProjectJournal } from '../store/journal.js';
import type { PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import type { PackageRuntimeRef } from '../domain/runtime-refs.js';
import { untrustedProtectedFiles } from './protected-milestones.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const spec: GoalSpec = {
  ...baseSpec,
  checks: [
    { id: 'CHK-A', kind: 'command', command: 'node a.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
    { id: 'CHK-B', kind: 'command', command: 'node b.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
    { id: 'CHK-C', kind: 'command', command: 'node c.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
    { id: 'CHK-M', kind: 'manual', procedure: 'Inspect result', expectedResult: 'Correct result' },
  ],
  acceptance: [{ ...baseSpec.acceptance[0], checkIds: ['CHK-A', 'CHK-B', 'CHK-C', 'CHK-M'] }],
};
const a: WorkPackageSpec = {
  id: 'WP-01',
  goalId: spec.id,
  goalVersion: 1,
  version: 1,
  owner: 'worker-a',
  outcome: 'scanner',
  scope: ['scanner'],
  exclusions: [],
  dependencies: [],
  interfaces: ['scan(token)@v1'],
  acceptance: [{ id: 'WP-AC-1', text: 'scan works', goalAcceptanceId: 'AC-1', checkIds: ['CHK-A'] }],
  integration: 'Lead integrates',
};
const b: WorkPackageSpec = {
  ...a,
  id: 'WP-02',
  owner: 'worker-b',
  outcome: 'history',
  scope: ['history'],
  dependencies: ['WP-01'],
  acceptance: [{ id: 'WP-AC-2', text: 'history works', checkIds: ['CHK-B'] }],
};
const c: WorkPackageSpec = {
  ...b,
  id: 'WP-03',
  owner: 'worker-c',
  dependencies: ['WP-02'],
  acceptance: [{ id: 'WP-AC-3', text: 'third step works', checkIds: ['CHK-C'] }],
};

it('gates each package on its own head, returns a red one to its owner, and wakes the Lead once per batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-multi-'));
  dirs.push(dir);
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-multi-art-'));
  dirs.push(artifacts);
  execFileSync('git', ['init', '-q', dir]);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const attempts: Record<string, number> = {};
  const settled = new Set<string>();
  const wakes: string[][] = [];
  const reviewerStarts: string[] = [];
  let refusedOnce = false;
  // Orca refuses a wake while the Lead terminal is still bound to its last, unretained dispatch (seen live).
  const retained = new Set<string>();
  let leadDispatch = 'lead-0';
  let leadBase = '';
  let leadTree = '';
  const work = (item: WorkPackageSpec, path: string, base: string) => {
    attempts[item.id] = (attempts[item.id] ?? 0) + 1;
    const n = attempts[item.id];
    const file = item.id === 'WP-01' ? 'a.js' : item.id === 'WP-02' ? 'b.js' : 'c.js';
    // WP-01's first attempt is broken; everything else works.
    writeFileSync(join(path, file), item.id === 'WP-01' && n === 1 ? 'process.exit(1);' : 'process.exit(0);');
    const report = join(path, packageReportPath(spec.id, item.id, item.version, n));
    execFileSync('node', [
      '-e',
      `require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true})`,
      report,
    ]);
    writeFileSync(report, `# ${item.id}\n${activationLine(committedFileDigest(dir, base, CORE_SKILL))}\n`);
    git(path, 'add', '-A');
    git(path, '-c', 'user.name=W', '-c', 'user.email=w@local.invalid', 'commit', '-qm', `${item.id} attempt ${n}`);
    settled.add(`${item.id}-${n}`);
    return `${item.id}-${n}`;
  };
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startLead({ repoPath }) {
      leadBase = git(repoPath, 'rev-parse', 'HEAD');
      leadTree = join(mkdtempSync(join(tmpdir(), 'apos-multi-lead-')), 'wt');
      dirs.push(join(leadTree, '..'));
      git(repoPath, 'worktree', 'add', '-q', '--detach', leadTree, leadBase);
      return {
        runId: 'run-lead',
        taskId: 'lead',
        dispatchId: 'lead-0',
        owner: 'lead',
        repoPath,
        terminal: 'term-lead',
        worktreeId: `repo::${leadTree}`,
        baseCommit: leadBase,
      };
    },
    async retainWorker(dispatchId: string) {
      retained.add(dispatchId);
    },
    async resumeSolo() {
      throw new Error('no Solo');
    },
    async inspect(ref) {
      return { state: 'settled', outcome: 'completed', ref };
    },
    async startPackage({ package: item, repoPath, dependencyCommits }) {
      const base = dependencyCommits?.at(-1) ?? git(repoPath, 'rev-parse', 'HEAD');
      const path = join(mkdtempSync(join(tmpdir(), 'apos-multi-wt-')), 'wt');
      dirs.push(join(path, '..'));
      git(repoPath, 'worktree', 'add', '-q', '--detach', path, base);
      const dispatchId = work(item, path, base);
      return {
        runId: 'run-1',
        taskId: item.id,
        dispatchId,
        owner: 'worker',
        repoPath,
        terminal: `term-${item.id}`,
        worktreeId: `repo::${path}`,
        baseCommit: base,
      };
    },
    async resumePackage({ package: item, prior, finding }) {
      expect(finding).toMatch(/CHK-A fail/);
      const dispatchId = work(item, prior.worktreeId!.split('::')[1], prior.baseCommit!);
      return { ...prior, dispatchId };
    },
    async inspectPackage(ref: PackageRuntimeRef) {
      return settled.has(ref.dispatchId) ? 'completed' : 'live';
    },
    async deliveryHead(ref) {
      return git(ref.worktreeId!.split('::')[1], 'rev-parse', 'HEAD');
    },
    async wakeLead(input) {
      if (!retained.has(leadDispatch))
        throw new OrcaRefused(`terminal still bound to ${leadDispatch}`, 'agent_unconfigured');
      if (input.events.some(item => /Goal review passed/.test(item)) && !refusedOnce) {
        refusedOnce = true;
        throw new Error('[agent_unconfigured] Orca refused the wake');
      }
      wakes.push(input.events);
      leadDispatch = `lead-${wakes.length}`;
      return { dispatchId: leadDispatch };
    },
    async startReviewer(input) {
      reviewerStarts.push(input.idempotencyKey);
      const path = join(mkdtempSync(join(tmpdir(), 'apos-multi-rev-')), 'wt');
      dirs.push(join(path, '..'));
      git(dir, 'worktree', 'add', '-q', '--detach', path, input.commit);
      const file = join(path, reviewResultPath(spec.id, input.idempotencyKey));
      execFileSync('node', [
        '-e',
        `require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true})`,
        file,
      ]);
      writeFileSync(
        file,
        JSON.stringify({
          result: reviewerStarts.length === 1 ? 'changes' : 'pass',
          note: 'Reviewed the integration commit against the Goal.',
        }),
      );
      git(path, 'add', '-f', '-A');
      git(path, '-c', 'user.name=R', '-c', 'user.email=r@local.invalid', 'commit', '-qm', 'review');
      return {
        runId: 'run-1',
        taskId: 'rev',
        dispatchId: `rev-${reviewerStarts.length}`,
        owner: 'lead',
        repoPath: input.repoPath,
        terminal: 'term-rev',
        worktreeId: `repo::${path}`,
      };
    },
  };
  const output: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { runtime, gate: { artifactRoot: artifacts }, write: line => output.push(line) });
  const input = (name: string, data: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
    return path;
  };
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.json\nbrief.md\n');
  await invoke('init');
  await invoke('goal', 'create', '--file', input('goal.json', spec), '--source', input('brief.md', sourceText));
  await invoke(
    'goal',
    'approve',
    spec.id,
    '--size',
    'M',
    '--max-spend',
    '20',
    '--max-minutes',
    '240',
    '--max-attempts',
    '3',
  );
  await invoke('goal', 'select', spec.id);
  await invoke('controller', 'tick'); // the controller alone dispatches the Lead
  process.env.ORCA_TERMINAL_HANDLE = 'term-lead'; // the Lead APOS dispatched at selection plans and commits
  try {
    await invoke('lead', 'propose', '--file', input('plan.json', { ...proposal, mode: 'multi-wp' }));
    await invoke('package', 'add', '--file', input('a.json', a), '--reason', 'First stage');
    await invoke('package', 'add', '--file', input('b.json', b), '--reason', 'Second stage');
    await invoke('package', 'add', '--file', input('c.json', c), '--reason', 'Third stage');
    await invoke('lead', 'commit', spec.id);
  } finally {
    delete process.env.ORCA_TERMINAL_HANDLE;
  }
  await invoke('controller', 'tick'); // the controller dispatches the ready packages
  process.env.ORCA_TERMINAL_HANDLE = 'term-lead';
  try {
    await expect(invoke('package', 'evidence', spec.id, '--file', input('bad.json', {}))).rejects.not.toThrow(
      /Lead or Human only/,
    );
    await expect(invoke('package', 'verify', spec.id, 'not-a-package')).rejects.not.toThrow(/Lead or Human only/);
  } finally {
    delete process.env.ORCA_TERMINAL_HANDLE;
  }
  process.env.ORCA_TERMINAL_HANDLE = 'term-WP-01';
  try {
    await expect(invoke('gate', 'run', spec.id, '--commit', leadBase, '--base', leadBase)).rejects.toThrow(/Human/);
    await expect(invoke('package', 'evidence', spec.id, '--file', input('fake.json', {}))).rejects.toThrow(
      /Lead|Human/,
    );
    await expect(invoke('package', 'verify', spec.id, 'WP-01')).rejects.toThrow(/Lead|Human/);
    await expect(invoke('package', 'approve', spec.id, 'WP-02', '--reason', 'self approve')).rejects.toThrow(/Lead/);
    await expect(
      invoke('package', 'add', '--file', input('unauthorized.json', c), '--reason', 'self add'),
    ).rejects.toThrow(/Lead/);
  } finally {
    delete process.env.ORCA_TERMINAL_HANDLE;
  }
  // Wake-ups target the Lead's own terminal, known from its dispatch, with no --terminal flag.
  const state = () => {
    const opened = ProjectJournal.open(dir);
    try {
      return opened.journal.getGoal(spec.id)!;
    } finally {
      opened.close();
    }
  };
  expect(state().leadTerminal).toMatchObject({ terminal: 'term-lead', runId: 'run-lead' });

  // The tick after the commit dispatched WP-01, saw it settle and gated it red in one pass.
  expect(state().packages!['WP-01'].status).toBe('stale');
  expect(state().packages!['WP-01'].finding).toMatch(/CHK-A fail/);
  expect(wakes.at(-1)!.join('\n')).toMatch(/WP-01 v1 attempt 1 red, returned to its owner/);
  await invoke('controller', 'tick'); // resumes WP-01 in its own worktree
  expect(attempts['WP-01']).toBe(2);
  for (let i = 0; i < 3; i++) await invoke('controller', 'tick');
  expect(state().packages!['WP-01'].status).toBe('verified');
  expect(state().packages!['WP-02'].status).toBe('specified');
  process.env.ORCA_TERMINAL_HANDLE = 'term-lead';
  await invoke('package', 'hold', spec.id, 'WP-02', '--reason', 'Need another look');
  delete process.env.ORCA_TERMINAL_HANDLE;
  await invoke('controller', 'tick');
  expect(state().packages!['WP-02'].status).toBe('specified');
  process.env.ORCA_TERMINAL_HANDLE = 'term-lead';
  await invoke('package', 'approve', spec.id, 'WP-02', '--reason', 'Reviewed prerequisite');
  delete process.env.ORCA_TERMINAL_HANDLE;
  for (let i = 0; i < 3; i++) await invoke('controller', 'tick');
  expect(state().packages!['WP-02'].status).toBe('verified');
  process.env.ORCA_TERMINAL_HANDLE = 'term-lead';
  await invoke('package', 'approve', spec.id, 'WP-03', '--reason', 'Reviewed second package');
  delete process.env.ORCA_TERMINAL_HANDLE;
  for (let i = 0; i < 3; i++) await invoke('controller', 'tick');
  expect(state().packages!['WP-03'].status).toBe('verified');
  const log = readFileSync(join(leadTree, '.apos', 'goals', spec.id, 'lead-log.md'), 'utf8');
  expect(log).toContain('Reviewed prerequisite');
  expect(log).toContain('Need another look');
  expect(log).toContain('Reviewed second package');
  const reopened = ProjectJournal.open(dir);
  expect(reopened.journal.events(spec.id).filter(event => event.type === 'package-dispatch-approved')).toHaveLength(2);
  reopened.close();
  const all = wakes.flat();
  expect(all).toEqual(expect.arrayContaining(['all packages verified: ready to integrate']));
  expect(all.filter(item => item === 'all packages verified: ready to integrate')).toHaveLength(1);

  // Seen live: after the Lead integrated and the gate went green, nobody dispatched the Goal reviewer.
  const heads = Object.values(state().packages!).map(item => item.evidence.at(-1)!.commitRef);
  expect(state().packages!['WP-02'].runtimeRef?.baseCommit).toBe(heads[0]);
  expect(state().packages!['WP-03'].runtimeRef?.baseCommit).toBe(heads[1]);
  git(leadTree, 'checkout', '-q', '--detach', heads[2]);
  const integrationCommit = git(leadTree, 'rev-parse', 'HEAD');
  await invoke('controller', 'tick');
  expect(state().gate?.result).toBe('pending');
  await invoke(
    'gate',
    'confirm',
    spec.id,
    'CHK-M',
    '--commit',
    integrationCommit,
    '--by',
    'human',
    '--note',
    'checked',
  );
  await invoke('controller', 'tick');
  expect(state().gate?.checks.map(check => [check.checkId, check.status, check.reason])).toEqual([
    ['CHK-A', 'pass', expect.anything()],
    ['CHK-B', 'pass', expect.anything()],
    ['CHK-C', 'pass', expect.anything()],
    ['CHK-M', 'pass', expect.anything()],
  ]);
  expect(state().gate?.result).toBe('green');
  expect(state().gate?.baseCommit).toBe(leadBase);
  await expect(invoke('gate', 'run', spec.id, '--commit', integrationCommit, '--base', heads[1])).rejects.toThrow(
    /proposal base commit/,
  );
  const published = state().publishedDocuments;
  expect(published?.length).toBeGreaterThan(0); // state() reopens and verifies the hash-chained log
  const opened = ProjectJournal.open(dir);
  expect(opened.journal.events(spec.id).some(event => event.type === 'documents-published')).toBe(true);
  const legacy = { getGoal: () => undefined };
  expect(untrustedProtectedFiles(legacy, spec.id, dir, integrationCommit, [`.apos/goals/${spec.id}/goal.md`])).toEqual([
    `.apos/goals/${spec.id}/goal.md`,
  ]);
  expect(() =>
    opened.journal.append({
      id: 'forged',
      goalId: spec.id,
      type: 'documents-published',
      at: new Date().toISOString(),
      data: published?.at(-1),
    }),
  ).toThrow(/controller-only/);
  opened.close();
  const protectedPath = `.apos/goals/${spec.id}/goal.md`;
  writeFileSync(join(leadTree, protectedPath), 'tampered');
  git(leadTree, 'add', protectedPath);
  git(leadTree, '-c', 'user.name=L', '-c', 'user.email=l@local.invalid', 'commit', '-qm', 'tamper');
  await invoke('gate', 'run', spec.id, '--commit', git(leadTree, 'rev-parse', 'HEAD'));
  expect(state().gate?.checks).toContainEqual(expect.objectContaining({ checkId: 'APOS-PROTECTED', status: 'fail' }));
  git(leadTree, 'checkout', '-q', '--detach', integrationCommit);
  await invoke('gate', 'run', spec.id, '--commit', integrationCommit);
  expect(state().gate?.result).toBe('green');
  for (let i = 0; i < 3; i++) await invoke('controller', 'tick');
  expect(state().reviews.at(-1)).toMatchObject({ result: 'changes', commitRef: integrationCommit });
  expect(wakes.flat().join('\n')).toMatch(/Goal review requested changes/);
  writeFileSync(join(leadTree, 'repair.txt'), 'review fix');
  git(leadTree, 'add', 'repair.txt');
  git(leadTree, '-c', 'user.name=L', '-c', 'user.email=l@local.invalid', 'commit', '-qm', 'review fix');
  const repaired = git(leadTree, 'rev-parse', 'HEAD');
  await invoke('controller', 'tick');
  await invoke('gate', 'confirm', spec.id, 'CHK-M', '--commit', repaired, '--by', 'human', '--note', 'checked repair');
  for (let i = 0; i < 5; i++) await invoke('controller', 'tick'); // first pass wake is refused and retried
  expect(reviewerStarts).toHaveLength(2);
  expect(state().reviews.at(-1)).toMatchObject({
    subject: 'goal',
    result: 'pass',
    commitRef: repaired,
    session: 'rev-2',
  });
  expect(wakes.flat().join('\n')).toMatch(new RegExp(`Goal review passed on ${repaired}: .*integration complete`));
  await invoke('controller', 'tick');
  expect(reviewerStarts).toHaveLength(2); // a passed review is not asked for again
  await invoke('integration', 'complete', spec.id, '--commit', repaired);
  expect(state().status).toBe('verified');
}, 120_000);
