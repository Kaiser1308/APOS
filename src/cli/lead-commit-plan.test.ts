import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { ProjectJournal } from '../store/journal.js';
import { setupSha256 } from '../domain/project-setup.js';
import { newEvent } from '../app/events.js';
import { proposal, sourceText, spec } from '../domain/fixtures.test-support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

async function plannedGoal(pinSetup: boolean) {
  const dir = temp('apos-plan-repo-');
  const home = temp('apos-plan-home-');
  execFileSync('git', ['init', '-q', dir]);
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { home, write: () => undefined });
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
  await invoke('init');
  if (pinSetup) {
    const { journal, close } = ProjectJournal.open(dir, home, newEvent);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const base = { sha256: setupSha256(readFileSync(join(dir, '.apos', 'project.yaml'), 'utf8')), commit: head };
    const at = new Date().toISOString();
    journal.appendProjectEvent({ id: 'P1', type: 'setup-probed', at, data: { ...base, ok: true, results: [] } });
    journal.appendProjectEvent({
      id: 'A1',
      type: 'setup-approved',
      at,
      data: { ...base, version: 1, confirmation: { by: 'human' } },
    });
    close();
  }
  const human = ['--on-behalf', 't'];
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  await invoke('goal', 'approve', spec.id, '--size', 'M', '--max-minutes', '240', '--max-attempts', '3', ...human);
  await invoke('goal', 'select', spec.id, ...human);
  const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const propose = (extra: object) => {
    writeFileSync(
      join(dir, 'plan.json'),
      JSON.stringify({ ...proposal, rationale: 'one owner', baseCommit: base, ...extra }),
    );
    return invoke('lead', 'propose', '--file', join(dir, 'plan.json'));
  };
  return { dir, invoke, propose };
}

it('corrects duplicate criterion coverage through package revise before committing a Multi-WP plan', async () => {
  const { dir, invoke, propose } = await plannedGoal(false);
  await propose({ mode: 'multi-wp', splitRationale: 'separate responsibilities' });
  const wp = (id: string) => ({
    id,
    goalId: spec.id,
    goalVersion: 1,
    version: 1,
    owner: 'worker',
    outcome: 'outcome',
    scope: ['scope'],
    exclusions: [],
    dependencies: [],
    interfaces: ['api@v1'],
    acceptance: [{ id: `${id}-AC`, text: 'works', goalAcceptanceId: 'AC-1' }],
    integration: 'integrate',
  });
  const file = join(dir, 'package.json');
  const add = async (id: string) => {
    writeFileSync(file, JSON.stringify(wp(id)));
    await invoke('package', 'add', '--file', file, '--reason', 'draft');
  };
  await add('WP-01');
  await add('WP-02');
  await expect(invoke('lead', 'commit', spec.id)).rejects.toThrow(/AC-1 belongs to 2 packages/);
  writeFileSync(file, JSON.stringify({ ...wp('WP-02'), version: 2, acceptance: [{ id: 'WP-02-AC', text: 'other' }] }));
  await invoke('package', 'revise', spec.id, '--file', file, '--reason', 'correct coverage');
  await expect(invoke('lead', 'commit', spec.id)).resolves.toBeUndefined();
});

it('refuses to commit a plan without paths when the Goal pinned a setup, and says what is missing', async () => {
  const { invoke, propose } = await plannedGoal(true);
  await propose({});
  await expect(invoke('lead', 'commit', spec.id)).rejects.toThrow(/proposal\.paths is required/);
});

it('commits the same plan once it names paths, and without paths for a Goal that pinned no setup', async () => {
  const pinned = await plannedGoal(true);
  await pinned.propose({ paths: ['src/**'] });
  await expect(pinned.invoke('lead', 'commit', spec.id)).resolves.toBeUndefined();
  const loose = await plannedGoal(false);
  await loose.propose({});
  await expect(loose.invoke('lead', 'commit', spec.id)).resolves.toBeUndefined();
});

it('refuses a plan whose Lead-added layer is not in the setup, naming the layer, and accepts one the setup has', async () => {
  const { invoke, propose } = await plannedGoal(true);
  await propose({ paths: ['src/**'], layers: { submit: ['L3'] } });
  await expect(invoke('lead', 'commit', spec.id)).rejects.toThrow(
    /WP-MAIN adds L3 at submit, but no part its paths touch \(and not system\) defines L3/,
  );
});

it('refuses added layers for a Goal that has no setup: they would run nothing', async () => {
  const { invoke, propose } = await plannedGoal(false);
  await propose({ layers: { submit: ['L1'] } });
  await expect(invoke('lead', 'commit', spec.id)).rejects.toThrow(/not pinned to a setup/);
});
