import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { ProjectJournal } from '../store/journal.js';
import { newEvent } from './events.js';
import { initProject } from './init-project.js';
import { GateService, ShellExecutor, type CommandExecutor } from './gate-service.js';
import { PackageService } from './package-service.js';
import { spec as baseSpec, proposal, sourceText, approval } from '../domain/fixtures.test-support.js';
import type { GoalSpec } from '../domain/contracts.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const spec: GoalSpec = {
  ...baseSpec,
  checks: [
    { id: 'CHK-1', kind: 'command', command: 'node harness.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
  ],
};

async function project(maxAttempts = 3, executor?: CommandExecutor) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-submit-repo-'));
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-submit-art-'));
  const home = mkdtempSync(join(tmpdir(), 'apos-submit-home-'));
  dirs.push(dir, artifacts, home);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'harness.js'), "process.exit(require('fs').existsSync('feature.js') ? 0 : 1);");
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'base');
  await initProject(dir);
  const store = SqliteStore.open(join(dir, '.apos', 'state.sqlite'));
  stores.push(store);
  const journal = new ProjectJournal(dir, store, home, newEvent);
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    journal.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  journal.appendWithSource(
    { id: `EV-${++n}`, goalId: spec.id, type: 'goal-drafted', data: spec, at: '2026-11-07T00:00:00.000Z' },
    sourceText,
  );
  const base = git('rev-parse', 'HEAD');
  add('goal-approved', { appetite: { ...approval.appetite, maxAttempts } });
  add('goal-selected');
  add('proposal-drafted', { ...proposal, baseCommit: base });
  add('proposal-approved');
  const commit = (files: Record<string, string | null>, message: string) => {
    for (const [name, content] of Object.entries(files))
      if (content === null) rmSync(join(dir, name));
      else writeFileSync(join(dir, name), content);
    git('add', '-A', '--', '.', ':!.apos');
    git('-c', 'user.name=O', '-c', 'user.email=o@local.invalid', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const gate = new GateService(journal, { artifactRoot: artifacts, executor });
  const service = new PackageService(journal, { gate, repoPath: dir });
  const log = () => readFileSync(join(home, 'events', `${spec.id}.jsonl`), 'utf8');
  const types = () =>
    log()
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { event: { type: string } }).event.type);
  return { dir, git, base, commit, journal, service, add, types, home };
}

describe('package submit', () => {
  it('goes red, then green; a green Solo package verifies the Goal in the same command', async () => {
    const { commit, service, journal, types } = await project();
    const red = commit({ 'note.txt': 'wip' }, 'wip');
    const first = await service.submit(spec.id, 'WP-MAIN', red, 'lead');
    expect(first.result).toBe('red');
    expect(first.reasons.join(' ')).toMatch(/CHK-1 fail/);
    expect(journal.getGoal(spec.id)?.packages?.['WP-MAIN']).toMatchObject({ status: 'red', attempts: 1 });
    expect(journal.getGoal(spec.id)?.status).toBe('executing');

    const green = commit({ 'feature.js': 'module.exports = 1;' }, 'feature');
    const second = await service.submit(spec.id, 'WP-MAIN', green, 'lead');
    expect(second.reasons).toEqual([]);
    expect(second.result).toBe('green');
    expect(journal.getGoal(spec.id)).toMatchObject({ status: 'verified', verifiedCommit: green });
    expect(types().filter(type => type.startsWith('package-') || type === 'verified')).toEqual([
      'package-submitted',
      'package-gate-recorded',
      'package-submitted',
      'package-gate-recorded',
      'verified',
    ]);
  }, 60_000);

  it('refuses a commit that does not exist, or does not contain the base, before writing anything', async () => {
    const { git, dir, service, types } = await project();
    const before = types();
    await expect(service.submit(spec.id, 'WP-MAIN', 'f'.repeat(40), 'lead')).rejects.toThrow(/does not exist/);
    git('switch', '-q', '--orphan', 'other');
    writeFileSync(join(dir, 'other.txt'), 'x');
    git('add', 'other.txt');
    git('-c', 'user.name=O', '-c', 'user.email=o@local.invalid', 'commit', '-qm', 'unrelated history');
    const unrelated = git('rev-parse', 'HEAD');
    await expect(service.submit(spec.id, 'WP-MAIN', unrelated, 'lead')).rejects.toThrow(/does not contain the base/);
    expect(types()).toEqual(before);
  }, 60_000);

  it('refuses a package that is unknown, already green, or whose Goal is not executing', async () => {
    const { commit, service, add } = await project();
    const good = commit({ 'feature.js': 'module.exports = 1;' }, 'feature');
    await expect(service.submit(spec.id, 'WP-NOPE', good, 'lead')).rejects.toThrow(/Unknown package/);
    await service.submit(spec.id, 'WP-MAIN', good, 'lead');
    await expect(service.submit(spec.id, 'WP-MAIN', good, 'lead')).rejects.toThrow(
      /is verified: only an executing Goal/,
    );
    add('outcome-stopped');
    await expect(service.submit(spec.id, 'WP-MAIN', good, 'lead')).rejects.toThrow(/is verified|terminal|stopped/);
  }, 60_000);

  it('blocks the Goal once reds pass the approved attempts', async () => {
    const { commit, service, journal } = await project(1);
    for (let n = 0; n < 2; n++)
      await service.submit(spec.id, 'WP-MAIN', commit({ 'note.txt': `wip ${n}` }, `wip ${n}`), 'lead');
    expect(journal.getGoal(spec.id)).toMatchObject({ status: 'blocked' });
    expect(journal.getGoal(spec.id)?.packages?.['WP-MAIN']?.attempts).toBe(2);
  }, 60_000);

  it('leaves no gate record when the gate is interrupted, and the package can be submitted again', async () => {
    let interrupted = true;
    const real = new ShellExecutor();
    const executor: CommandExecutor = {
      shell: real.shell,
      run: (command, cwd, env, timeoutMs) => {
        if (interrupted) throw new Error('Interrupted (Ctrl-C)');
        return real.run(command, cwd, env, timeoutMs);
      },
    };
    const { commit, service, journal, types } = await project(3, executor);
    const good = commit({ 'feature.js': 'module.exports = 1;' }, 'feature');
    const before = types();
    await expect(service.submit(spec.id, 'WP-MAIN', good, 'lead')).rejects.toThrow(/Interrupted/);
    expect(types()).toEqual(before);
    expect(journal.getGoal(spec.id)?.packages?.['WP-MAIN']?.status).toBe('pending');
    interrupted = false;
    expect((await service.submit(spec.id, 'WP-MAIN', good, 'lead')).result).toBe('green');
  }, 60_000);

  it('can finish a submission whose gate record was lost between the two writes', async () => {
    const { commit, service, journal, add, base } = await project();
    const good = commit({ 'feature.js': 'module.exports = 1;' }, 'feature');
    add('package-submitted', { packageId: 'WP-MAIN', version: 1, commit: good, base, by: 'lead' });
    expect(journal.getGoal(spec.id)?.packages?.['WP-MAIN']?.status).toBe('submitted');
    expect((await service.submit(spec.id, 'WP-MAIN', good, 'lead')).result).toBe('green');
  }, 60_000);
});
