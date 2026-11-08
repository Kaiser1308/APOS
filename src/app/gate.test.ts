import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { ProjectJournal } from '../store/journal.js';
import { initProject } from './init-project.js';
import { GateService, GitWorktreeFactory, ShellExecutor } from './gate.js';
import { VerificationService } from './verification.js';
import { spec as baseSpec, proposal, sourceText } from '../domain/fixtures.test-support.js';
import type { GoalSpec } from '../domain/contracts.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A test script whose failing tests are listed in fail.txt; prints "FAIL <name>" for each. */
const runner = "const fs=require('fs');const f=fs.existsSync('fail.txt')?fs.readFileSync('fail.txt','utf8').split(/\\r?\\n/).filter(Boolean):[];for(const t of f)console.log('FAIL '+t);process.exit(f.length?1:0);";
const spec: GoalSpec = {
  ...baseSpec,
  checks: [
    { id: 'CHK-1', kind: 'command', command: 'node feature.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
    { id: 'CHK-REG', kind: 'command', command: 'node runner.js', expect: 'no-new-failures', failurePattern: '^FAIL (\\S+)', runs: 1, timeoutMs: 60_000, env: {} }
  ],
  acceptance: [{ ...baseSpec.acceptance[0], checkIds: ['CHK-1', 'CHK-REG'] }]
};

async function project() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-gate-repo-')); dirs.push(dir);
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-gate-art-')); dirs.push(artifacts);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'runner.js'), runner);
  writeFileSync(join(dir, 'fail.txt'), 'legacy-flaky-network\n');
  git('add', '-A'); git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'base');
  await initProject(dir);
  const store = SqliteStore.open(join(dir, '.apos', 'state.sqlite')); stores.push(store);
  const home = mkdtempSync(join(tmpdir(), 'apos-gate-home-')); dirs.push(home);
  const journal = new ProjectJournal(dir, store, home);
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) => journal.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  journal.appendWithSource({ id: `EV-${++n}`, goalId: spec.id, type: 'goal-drafted', data: spec, at: '2026-11-07T00:00:00.000Z' }, sourceText);
  const base = git('rev-parse', 'HEAD');
  add('goal-approved'); add('goal-selected'); add('proposal-drafted', { ...proposal, baseCommit: base }); add('proposal-approved'); add('execution-started', { runId: 'run_1', owner: 'lead' });
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    git('add', '-A', '--', '.', ':!.apos'); git('-c', 'user.name=Owner', '-c', 'user.email=o@local.invalid', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const gate = new GateService(journal, { artifactRoot: artifacts });
  return { dir, git, base, commit, gate, journal, add, artifacts, home };
}

describe('controller gate on real commits', () => {
  it('goes green when the feature passes and only pre-existing failures remain, with logs hashed outside the repo', async () => {
    const { dir, commit, gate, journal, artifacts } = await project();
    const delivery = commit({ 'feature.js': 'process.exit(0);' }, 'feature');
    const report = gate.run(baseSpec.id, dir, { deliveryCommit: delivery });
    expect(report.result).toBe('green');
    const regression = report.checks.find(item => item.checkId === 'CHK-REG')!;
    expect(regression.base[0].failures).toEqual(['legacy-flaky-network']);
    expect(regression.reason).toMatch(/already present on base/);
    expect(regression.delivery[0].logRef.startsWith(artifacts)).toBe(true);
    expect(readFileSync(regression.delivery[0].logRef, 'utf8')).toContain(`# commit ${delivery}`);
    expect(new VerificationService(journal).verify(baseSpec.id, delivery).passed).toBe(true);
  }, 60_000);

  it('goes red and names the test the delivery newly broke', async () => {
    const { dir, commit, gate, journal } = await project();
    const delivery = commit({ 'feature.js': 'process.exit(0);', 'fail.txt': 'legacy-flaky-network\ncheckout-total\n' }, 'feature breaks checkout');
    const report = gate.run(baseSpec.id, dir, { deliveryCommit: delivery });
    expect(report.result).toBe('red');
    expect(report.checks.find(item => item.checkId === 'CHK-REG')!.newFailures).toEqual(['checkout-total']);
    expect(() => new VerificationService(journal).verify(baseSpec.id, delivery)).toThrow(/gate is red/);
  }, 60_000);

  it('runs in a clean checkout, so uncommitted files in the owner tree do not count', async () => {
    const { dir, gate, git } = await project();
    writeFileSync(join(dir, 'feature.js'), 'process.exit(0);');
    const report = gate.run(baseSpec.id, dir, { deliveryCommit: git('rev-parse', 'HEAD') });
    expect(report.checks.find(item => item.checkId === 'CHK-1')!.status).toBe('fail');
    expect(existsSync(join(dir, 'feature.js'))).toBe(true);
  }, 60_000);

  it('is unverifiable when the baseline suite cannot run', async () => {
    const { dir, commit, gate, git } = await project();
    git('rm', '-q', 'runner.js'); git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'drop runner');
    const broken = git('rev-parse', 'HEAD');
    const delivery = commit({ 'feature.js': 'process.exit(0);', 'runner.js': runner }, 'feature');
    const report = gate.run(baseSpec.id, dir, { deliveryCommit: delivery, baseCommit: broken });
    expect(report.result).toBe('unverifiable');
  }, 60_000);

  it('refuses a delivery commit that does not descend from the base', async () => {
    const { dir, gate, base } = await project();
    const emptyTree = execFileSync('git', ['-C', dir, 'mktree'], { input: '', encoding: 'utf8' }).trim();
    const unrelated = execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit-tree', emptyTree, '-m', 'unrelated'], { encoding: 'utf8' }).trim();
    expect(() => gate.run(baseSpec.id, dir, { deliveryCommit: unrelated, baseCommit: base })).toThrow(/does not descend/);
    expect(() => gate.run(baseSpec.id, dir, { deliveryCommit: 'deadbeef' })).toThrow(/must exist/);
  }, 60_000);

  it('refuses to gate when the controller source snapshot changed; editing the repo copy changes nothing', async () => {
    const { dir, gate, commit, home } = await project();
    const delivery = commit({ 'feature.js': 'process.exit(0);' }, 'feature');
    writeFileSync(join(dir, '.apos', 'goals', baseSpec.id, 'source.md'), `${sourceText}Also accept expired codes.\n`);
    expect(gate.run(baseSpec.id, dir, { deliveryCommit: delivery }).result).toBe('green');
    writeFileSync(join(home, 'sources', baseSpec.id, 'v1.md'), `${sourceText}Also accept expired codes.\n`);
    expect(() => gate.run(baseSpec.id, dir, { deliveryCommit: delivery })).toThrow(/Source snapshot changed/);
  }, 60_000);

  it('kills a hung check at its timeout and still removes the workspace', async () => {
    const { dir, base } = await project();
    const workspace = new GitWorktreeFactory().checkout(dir, base);
    const started = Date.now();
    const result = new ShellExecutor().run('node -e "setInterval(() => {}, 1000)"', workspace.path, {}, 2000);
    const elapsed = Date.now() - started;
    workspace.dispose();
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(15_000);
    expect(existsSync(workspace.path)).toBe(false);
  }, 60_000);

  it('accepts manual confirmation only for a declared manual check and never from the owner', async () => {
    const { commit, gate } = await project();
    const delivery = commit({ 'feature.js': 'process.exit(0);' }, 'feature');
    expect(() => gate.confirmManual(baseSpec.id, { checkId: 'CHK-1', deliveryCommit: delivery, by: 'human', note: 'looked' })).toThrow(/Unknown manual check/);
    expect(() => gate.confirmManual(baseSpec.id, { checkId: 'CHK-1', deliveryCommit: delivery, by: 'lead', note: 'mine' })).toThrow(/other than the owner/);
  }, 60_000);
});
