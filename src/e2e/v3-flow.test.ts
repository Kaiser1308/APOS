import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { ProjectJournal } from '../store/journal.js';
import { proposal, sourceText, spec as baseSpec } from '../domain/fixtures.test-support.js';
import type { GoalSpec } from '../domain/contracts.js';

/** Whole Goals through the CLI on a scratch Git repo: no Orca, no agent, no controller. Human commands use --on-behalf. */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const check = (id: string, file: string) => ({
  id,
  kind: 'command' as const,
  command: `node ${file}`,
  expect: 'pass' as const,
  runs: 1,
  timeoutMs: 60_000,
  env: {},
});
const exists = (file: string) => `process.exit(require('fs').existsSync('${file}') ? 0 : 1);`;

async function project(spec: GoalSpec, harness: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-e2e-'));
  const home = mkdtempSync(join(tmpdir(), 'apos-e2e-home-'));
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-e2e-art-'));
  dirs.push(dir, home, artifacts);
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.json\nbrief.md\n');
  for (const [name, content] of Object.entries(harness)) writeFileSync(join(dir, name), content);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'harness');
  const out: string[] = [];
  const invoke = async (...args: string[]) => {
    process.exitCode = undefined;
    await runCli(['--repo', dir, ...args], { home, gate: { artifactRoot: artifacts }, write: line => out.push(line) });
    return process.exitCode as number | undefined;
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    git('add', '-A');
    git('-c', 'user.name=Lead', '-c', 'user.email=lead@local.invalid', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const json = (name: string, value: unknown) => {
    writeFileSync(join(dir, name), JSON.stringify(value));
    return join(dir, name);
  };
  writeFileSync(join(dir, 'brief.md'), sourceText);
  await invoke('init');
  const base = git('rev-parse', 'HEAD');
  const human = ['--on-behalf', 'item 1'];
  await invoke('goal', 'create', '--file', json('goal.json', spec), '--source', join(dir, 'brief.md'));
  await invoke('goal', 'approve', spec.id, '--size', 'M', '--max-minutes', '240', '--max-attempts', '3', ...human);
  await invoke('goal', 'select', spec.id, ...human);
  const state = () => {
    const opened = ProjectJournal.open(dir, home);
    try {
      return opened.journal.getGoal(spec.id)!;
    } finally {
      opened.close();
    }
  };
  return { dir, git, base, out, invoke, commit, json, human, state, home };
}

describe('Solo Goal without any agent runtime', () => {
  const spec: GoalSpec = { ...baseSpec, checks: [check('CHK-1', 'harness.js')] };

  it('goes init → create → approve → select → propose → commit → red submit → green submit → close', async () => {
    const p = await project(spec, { 'harness.js': exists('feature.js') });
    await p.invoke('lead', 'propose', '--file', p.json('plan.json', { ...proposal, baseCommit: p.base }));
    expect(p.state().status).toBe('planned');
    await p.invoke('lead', 'commit', spec.id);
    expect(p.state()).toMatchObject({ status: 'executing', packages: { 'WP-MAIN': { status: 'pending' } } });

    await expect(p.invoke('outcome', 'close', spec.id, ...p.human)).rejects.toThrow(/Verified Goal required/);

    const wip = p.commit({ 'notes.txt': 'wip' }, 'wip');
    expect(await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', wip)).toBe(1);
    expect(p.out.join('\n')).toMatch(/WP-MAIN red/);
    expect(p.state().packages?.['WP-MAIN']).toMatchObject({ status: 'red', attempts: 1 });

    const done = p.commit({ 'feature.js': 'module.exports = 1;' }, 'feature');
    expect(await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', done, '--json')).toBe(0);
    expect(p.state()).toMatchObject({ status: 'verified', verifiedCommit: done });

    await p.invoke('outcome', 'close', spec.id, ...p.human);
    expect(p.state().status).toBe('closed');
  }, 120_000);

  it('refuses a Human command with no terminal and no --on-behalf, and a commit that is not in the repo', async () => {
    const p = await project(spec, { 'harness.js': exists('feature.js') });
    await p.invoke('lead', 'propose', '--file', p.json('plan.json', { ...proposal, baseCommit: p.base }));
    await p.invoke('lead', 'commit', spec.id);
    await expect(p.invoke('outcome', 'stop', spec.id)).rejects.toThrow(/Human decision/);
    expect(p.state().status).toBe('executing');
    await expect(p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', 'f'.repeat(40))).rejects.toThrow(
      /does not exist/,
    );
    expect(p.state().packages?.['WP-MAIN']).toMatchObject({ status: 'pending', attempts: 0 });
  }, 120_000);

  it('keeps the Goal open when the target branch moved after verification and the post-merge gate is red', async () => {
    const p = await project(
      { ...spec, checks: [check('CHK-1', 'harness.js')] },
      {
        'harness.js': `${exists('feature.js').replace('process.exit(', "if (require('fs').existsSync('legacy.flag')) process.exit(1); process.exit(")}`,
      },
    );
    const target = p.git('branch', '--show-current');
    await p.invoke('lead', 'propose', '--file', p.json('plan.json', { ...proposal, baseCommit: p.base }));
    await p.invoke('lead', 'commit', spec.id);
    p.git('switch', '-q', '-c', 'work');
    const done = p.commit({ 'feature.js': 'module.exports = 1;' }, 'feature');
    expect(await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', done)).toBe(0);
    p.git('switch', '-q', target);
    p.commit({ 'legacy.flag': 'x' }, 'unrelated change');
    await expect(p.invoke('outcome', 'close', spec.id, ...p.human, '--merge-to', target)).rejects.toThrow(
      /Post-merge gate is red/,
    );
    expect(p.state()).toMatchObject({ status: 'verified', postMergeGate: { result: 'red' } });
  }, 120_000);
});

describe('Multi-WP Goal without any agent runtime', () => {
  const spec: GoalSpec = {
    ...baseSpec,
    checks: [check('CHK-A', 'check-a.js'), check('CHK-B', 'check-b.js')],
    acceptance: [{ ...baseSpec.acceptance[0], checkIds: ['CHK-A', 'CHK-B'] }],
  };
  const wp = (id: string, owner: string, checkId: string, covers?: string) => ({
    id,
    goalId: spec.id,
    goalVersion: 1,
    version: 1,
    owner,
    outcome: `${id} done`,
    scope: [id],
    exclusions: [],
    dependencies: [],
    interfaces: [`${id}-api@v1`],
    acceptance: [
      { id: `${id}-AC`, text: 'works', ...(covers ? { goalAcceptanceId: covers } : {}), checkIds: [checkId] },
    ],
    integration: 'Lead merges the two branches',
  });

  it('runs two packages, an integration gate, and closes on the integration commit', async () => {
    const p = await project(spec, { 'check-a.js': exists('a.js'), 'check-b.js': exists('b.js') });
    const plan = { ...proposal, mode: 'multi-wp', baseCommit: p.base, estimatedCost: { wallMinutes: 90 } };
    await p.invoke('lead', 'propose', '--file', p.json('plan.json', plan));
    await p.invoke(
      'package',
      'add',
      '--file',
      p.json('wp1.json', wp('WP-A', 'dev-a', 'CHK-A', 'AC-1')),
      '--reason',
      'split',
    );
    await p.invoke('package', 'add', '--file', p.json('wp2.json', wp('WP-B', 'dev-b', 'CHK-B')), '--reason', 'split');
    await p.invoke('lead', 'commit', spec.id);
    expect(p.state().status).toBe('executing');

    const trunk = p.git('branch', '--show-current');
    p.git('switch', '-q', '-c', 'wp-a', p.base);
    const a = p.commit({ 'a.js': 'module.exports = 1;' }, 'a');
    p.git('switch', '-q', '-c', 'wp-b', p.base);
    const b = p.commit({ 'b.js': 'module.exports = 2;' }, 'b');
    expect(await p.invoke('package', 'submit', spec.id, 'WP-A', '--commit', a)).toBe(0);
    expect(await p.invoke('package', 'submit', spec.id, 'WP-B', '--commit', b)).toBe(0);
    expect(p.state().status).toBe('executing');

    p.git('switch', '-q', '-c', 'integration', 'wp-a');
    p.git('-c', 'user.name=Lead', '-c', 'user.email=lead@local.invalid', 'merge', '--no-edit', 'wp-b');
    const integration = p.git('rev-parse', 'HEAD');
    await p.invoke('integration', 'gate', spec.id, '--commit', integration, '--reason', 'merge of WP-A and WP-B');
    await p.invoke('integration', 'complete', spec.id, '--commit', integration);
    expect(p.state()).toMatchObject({ status: 'verified', verifiedCommit: integration });

    await p.invoke('outcome', 'close', spec.id, ...p.human);
    expect(p.state().status).toBe('closed');
    void trunk;
  }, 180_000);
});
