import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { spec as baseSpec, proposal, sourceText } from '../domain/fixtures.test-support.js';
import type { GoalSpec } from '../domain/contracts.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import type { RuntimeAdapter } from '../runtime/orca.js';
import type { PackageRuntime, PackageRuntimeRef } from './packages.js';
import { CORE_SKILL, activationLine, committedFileDigest, packageReportPath, reviewResultPath } from '../runtime/brief.js';
import { ProjectJournal } from '../store/journal.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const spec: GoalSpec = {
  ...baseSpec,
  checks: [
    { id: 'CHK-A', kind: 'command', command: 'node a.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
    { id: 'CHK-B', kind: 'command', command: 'node b.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} }
  ],
  acceptance: [{ ...baseSpec.acceptance[0], checkIds: ['CHK-A', 'CHK-B'] }]
};
const a: WorkPackageSpec = { id: 'WP-01', goalId: spec.id, goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'scanner', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['scan(token)@v1'], acceptance: [{ id: 'WP-AC-1', text: 'scan works', goalAcceptanceId: 'AC-1', checkIds: ['CHK-A'] }], integration: 'Lead integrates' };
const b: WorkPackageSpec = { ...a, id: 'WP-02', owner: 'worker-b', outcome: 'history', scope: ['history'], dependencies: ['WP-01'], acceptance: [{ id: 'WP-AC-2', text: 'history works', checkIds: ['CHK-B'] }] };

it('gates each package on its own head, returns a red one to its owner, and wakes the Lead once per batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-multi-')); dirs.push(dir);
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-multi-art-')); dirs.push(artifacts);
  execFileSync('git', ['init', '-q', dir]);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const attempts: Record<string, number> = {};
  const settled = new Set<string>();
  const wakes: string[][] = [];
  const reviewerStarts: string[] = [];
  let verdict = 'pass';
  let refusedOnce = false;
  const work = (item: WorkPackageSpec, path: string, base: string) => {
    attempts[item.id] = (attempts[item.id] ?? 0) + 1;
    const n = attempts[item.id];
    const file = item.id === 'WP-01' ? 'a.js' : 'b.js';
    // WP-01's first attempt is broken; everything else works.
    writeFileSync(join(path, file), item.id === 'WP-01' && n === 1 ? 'process.exit(1);' : 'process.exit(0);');
    const report = join(path, packageReportPath(spec.id, item.id, item.version, n));
    execFileSync('node', ['-e', `require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true})`, report]);
    writeFileSync(report, `# ${item.id}\n${activationLine(committedFileDigest(dir, base, CORE_SKILL))}\n`);
    git(path, 'add', '-A'); git(path, '-c', 'user.name=W', '-c', 'user.email=w@local.invalid', 'commit', '-qm', `${item.id} attempt ${n}`);
    settled.add(`${item.id}-${n}`);
    return `${item.id}-${n}`;
  };
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startSolo() { throw new Error('no Solo'); }, async resumeSolo() { throw new Error('no Solo'); },
    async inspect(ref) { return { state: 'settled', outcome: 'completed', ref }; },
    async startPackage({ package: item, repoPath }) {
      const base = git(repoPath, 'rev-parse', 'HEAD');
      const path = join(mkdtempSync(join(tmpdir(), 'apos-multi-wt-')), 'wt'); dirs.push(join(path, '..'));
      git(repoPath, 'worktree', 'add', '-q', '--detach', path, base);
      const dispatchId = work(item, path, base);
      return { runId: 'run-1', taskId: item.id, dispatchId, owner: 'worker', repoPath, terminal: `term-${item.id}`, worktreeId: `repo::${path}`, baseCommit: base };
    },
    async resumePackage({ package: item, prior, finding }) {
      expect(finding).toMatch(/CHK-A fail/);
      const dispatchId = work(item, prior.worktreeId!.split('::')[1], prior.baseCommit!);
      return { ...prior, dispatchId };
    },
    async inspectPackage(ref: PackageRuntimeRef) { return settled.has(ref.dispatchId) ? 'completed' : 'live'; },
    async deliveryHead(ref) { return git(ref.worktreeId!.split('::')[1], 'rev-parse', 'HEAD'); },
    async wakeLead(input) {
      if (input.events.some(item => /Goal review passed/.test(item)) && !refusedOnce) { refusedOnce = true; throw new Error('[agent_unconfigured] Orca refused the wake'); }
      wakes.push(input.events); return { dispatchId: `lead-${wakes.length}` }; },
    async startReviewer(input) {
      reviewerStarts.push(input.idempotencyKey);
      const path = join(mkdtempSync(join(tmpdir(), 'apos-multi-rev-')), 'wt'); dirs.push(join(path, '..'));
      git(dir, 'worktree', 'add', '-q', '--detach', path, input.commit);
      const file = join(path, reviewResultPath(spec.id, input.idempotencyKey));
      execFileSync('node', ['-e', `require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true})`, file]);
      writeFileSync(file, JSON.stringify({ result: verdict, note: 'Reviewed the integration commit against the Goal.' }));
      git(path, 'add', '-f', '-A'); git(path, '-c', 'user.name=R', '-c', 'user.email=r@local.invalid', 'commit', '-qm', 'review');
      return { runId: 'run-1', taskId: 'rev', dispatchId: 'rev-1', owner: 'lead', repoPath: input.repoPath, terminal: 'term-rev', worktreeId: `repo::${path}` };
    }
  };
  const output: string[] = [];
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { runtime, gate: { artifactRoot: artifacts }, write: line => output.push(line) });
  const input = (name: string, data: unknown) => { const path = join(dir, name); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); return path; };
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.json\nbrief.md\n');
  await invoke('init');
  await invoke('goal', 'create', '--file', input('goal.json', spec), '--source', input('brief.md', sourceText));
  await invoke('goal', 'approve', spec.id, '--size', 'M', '--max-spend', '20', '--max-minutes', '240', '--max-attempts', '3');
  await invoke('goal', 'select', spec.id);
  await invoke('lead', 'propose', '--file', input('plan.json', { ...proposal, mode: 'multi-wp' }));
  await invoke('package', 'add', '--file', input('a.json', a));
  await invoke('package', 'add', '--file', input('b.json', b));
  await invoke('lead', 'commit', spec.id, '--terminal', 'term-lead', '--worktree', `path:${dir}`);
  const state = () => { const opened = ProjectJournal.open(dir); try { return opened.journal.getGoal(spec.id)!; } finally { opened.close(); } };

  await invoke('controller', 'tick');
  expect(state().packages!['WP-01'].status).toBe('stale');
  expect(state().packages!['WP-01'].finding).toMatch(/CHK-A fail/);
  expect(wakes.at(-1)!.join('\n')).toMatch(/WP-01 v1 attempt 1 red, returned to its owner/);
  await invoke('controller', 'tick'); // resumes WP-01 in its own worktree
  expect(attempts['WP-01']).toBe(2);
  for (let i = 0; i < 4; i++) await invoke('controller', 'tick');
  expect(state().packages!['WP-01'].status).toBe('verified');
  expect(state().packages!['WP-02'].status).toBe('verified');
  const all = wakes.flat();
  expect(all).toEqual(expect.arrayContaining(['all packages verified: ready to integrate']));
  expect(all.filter(item => item === 'all packages verified: ready to integrate')).toHaveLength(1);

  // Seen live: after the Lead integrated and the gate went green, nobody dispatched the Goal reviewer.
  const heads = Object.values(state().packages!).map(item => item.evidence.at(-1)!.commitRef);
  const integrationTree = join(mkdtempSync(join(tmpdir(), 'apos-multi-int-')), 'wt'); dirs.push(join(integrationTree, '..'));
  git(dir, 'worktree', 'add', '-q', '--detach', integrationTree, git(dir, 'rev-parse', 'HEAD'));
  git(integrationTree, '-c', 'user.name=L', '-c', 'user.email=l@local.invalid', 'merge', '-q', '--no-edit', ...heads);
  const integrationCommit = git(integrationTree, 'rev-parse', 'HEAD');
  await invoke('gate', 'run', spec.id, '--commit', integrationCommit);
  expect(state().gate?.result).toBe('green');
  for (let i = 0; i < 4; i++) await invoke('controller', 'tick'); // the first wake with the verdict is refused and retried
  expect(reviewerStarts).toHaveLength(1);                      // one reviewer per gated integration commit
  expect(state().reviews.at(-1)).toMatchObject({ subject: 'goal', result: 'pass', commitRef: integrationCommit, session: 'rev-1' });
  expect(wakes.flat().join('\n')).toMatch(new RegExp(`Goal review passed on ${integrationCommit}: .*integration complete`));
  await invoke('controller', 'tick');
  expect(reviewerStarts).toHaveLength(1);                      // a passed review is not asked for again
}, 120_000);
