import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { ProjectJournal } from '../store/journal.js';
import { newEvent } from '../app/events.js';
import { setupSha256 } from '../domain/project-setup.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { sourceText, spec } from '../domain/fixtures.test-support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const bench = { proof: 'benchmark', benchmark: { tool: 'app.L5.bench', metric: 'p95_ms', op: '<', value: 200 } };
const goalWith = (extra: object) => ({
  ...spec,
  acceptance: [...spec.acceptance, { ...spec.acceptance[0], id: 'AC-2', checkIds: [], ...extra }],
});
const setupDoc = (tools: object[]) => ({
  schemaVersion: 2,
  parts: { app: { root: '.', layers: { L5: tools } } },
});

async function approving(goal: object, setup: object | undefined) {
  const dir = temp('apos-proof-repo-');
  const home = temp('apos-proof-home-');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { home, write: () => undefined, writeError: () => undefined });
  await invoke('init');
  if (setup) {
    const text = jsonCodec.stringify(setup);
    writeFileSync(join(dir, '.apos', 'project.yaml'), text);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'setup']);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const { journal, close } = ProjectJournal.open(dir, home, newEvent);
    const base = { sha256: setupSha256(text), commit: head };
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
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(goal));
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  const approve = (...extra: string[]) =>
    invoke(
      'goal',
      'approve',
      spec.id,
      '--size',
      'M',
      '--max-minutes',
      '240',
      '--max-attempts',
      '3',
      '--on-behalf',
      't',
      ...extra,
    );
  const state = () => {
    const { journal, close } = ProjectJournal.open(dir, home, newEvent);
    try {
      return journal.getGoal(spec.id);
    } finally {
      close();
    }
  };
  return Object.assign(approve, { state });
}

it('refuses a benchmark criterion whose tool is not in the pinned setup, naming the criterion and the tool', async () => {
  const approve = await approving(goalWith(bench), setupDoc([]));
  await expect(approve()).rejects.toThrow(/AC-2 benchmark: the tool app\.L5\.bench is not in the pinned setup/);
});

it('refuses a tool of the wrong kind, and non-functional criteria when there is no setup at all', async () => {
  const wrong = await approving(goalWith(bench), setupDoc([{ id: 'bench', command: 'x', format: 'exit' }]));
  await expect(wrong()).rejects.toThrow(/reports exit, a benchmark needs a metric tool/);
  const none = await approving(goalWith(bench), undefined);
  await expect(none()).rejects.toThrow(/no approved setup to take their tools from/);
});

it('approves when the tool is there', async () => {
  const approve = await approving(
    goalWith(bench),
    setupDoc([{ id: 'bench', command: 'node b.js {report}', format: 'metric', metric: 'p95_ms' }]),
  );
  await expect(approve()).resolves.toBeUndefined();
});

const mutate = {
  id: 'mutate',
  command: 'x {changed}',
  format: 'metric',
  metric: 'mutationScore',
  when: 'flag:mutation',
};

it('refuses --flag mutation when the pinned setup has no tool that a mutation flag switches on', async () => {
  const approve = await approving(spec, setupDoc([]));
  await expect(approve('--flag', 'mutation')).rejects.toThrow(/the setup has no tool that says `when: flag:mutation`/);
  await expect(approve('--flag', 'not a word')).rejects.toThrow(/a flag is a word/);
});

it('approves with --flag mutation when the setup has the tool, and keeps the flag with the Goal', async () => {
  const approve = await approving(spec, setupDoc([mutate]));
  await approve('--flag', 'mutation', '--flag', 'perf');
  expect(approve.state()).toMatchObject({ status: 'approved', flags: ['mutation', 'perf'] });
});
