import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { ProjectJournal } from '../store/journal.js';
import { newEvent } from '../app/events.js';
import { spec, sourceText } from '../domain/fixtures.test-support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const sha = (c: string) => c.repeat(64);

async function project() {
  const dir = temp('apos-pin-repo-');
  const home = temp('apos-pin-home-');
  execFileSync('git', ['init', '-q', dir]);
  const out: string[] = [];
  const err: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { home, write: l => out.push(l), writeError: l => err.push(l) });
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
  await invoke('init');
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  const approveSetup = (version: number, letter: string) => {
    const { journal, close } = ProjectJournal.open(dir, home, newEvent);
    const base = { sha256: sha(letter), commit: letter.repeat(40) };
    journal.appendProjectEvent({
      id: `P${version}`,
      type: 'setup-probed',
      at: new Date().toISOString(),
      data: { ...base, ok: true, results: [] },
    });
    journal.appendProjectEvent({
      id: `A${version}`,
      type: 'setup-approved',
      at: new Date().toISOString(),
      data: { ...base, version, confirmation: { by: 'human' } },
    });
    close();
  };
  const state = () => {
    const { journal, close } = ProjectJournal.open(dir, home, newEvent);
    try {
      return journal.getGoal(spec.id);
    } finally {
      close();
    }
  };
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
  return { invoke, out, err, approveSetup, state, approve };
}

it('pins the latest approved setup at goal approve, and a later setup does not move a running Goal', async () => {
  const { invoke, out, approveSetup, state, approve } = await project();
  approveSetup(1, 'a');
  await approve();
  expect(out.at(-1)).toBe(`Approved ${spec.id} on setup v1`);
  expect(state()?.setupVersion).toBe(1);
  approveSetup(2, 'b');
  expect(state()?.setupVersion).toBe(1);
  out.length = 0;
  await invoke('goal', 'list');
  expect(out[0]).toMatch(/setup v1$/);
});

it('warns and pins nothing when no setup was approved; the list says "không có setup"', async () => {
  const { invoke, out, err, state, approve } = await project();
  await approve();
  expect(state()?.setupVersion).toBeUndefined();
  expect(err.join('\n')).toMatch(/Goal không có setup: bảo đảm theo setup tắt/);
  out.length = 0;
  await invoke('goal', 'list');
  expect(out[0]).toMatch(/không có setup$/);
});

it('lets the Human pin an older approved version, and refuses one that was never approved', async () => {
  const { approveSetup, state, approve } = await project();
  approveSetup(1, 'a');
  approveSetup(2, 'b');
  await expect(approve('--setup-version', '3')).rejects.toThrow(/never approved \(approved: 1, 2\)/);
  await approve('--setup-version', '1');
  expect(state()?.setupVersion).toBe(1);
});

it('the journal itself refuses a pin to a version that was never approved', async () => {
  const dir = temp('apos-pin-journal-');
  execFileSync('git', ['init', '-q', dir]);
  const { journal, close } = ProjectJournal.open(dir, temp('apos-pin-jhome-'), newEvent);
  try {
    journal.appendWithSource(newEvent(spec.id, 'goal-drafted', spec), sourceText);
    const approval = { appetite: { size: 'M', maxWallMinutes: 240, maxAttempts: 3, overrun: 'ask' }, setupVersion: 4 };
    expect(() => journal.append(newEvent(spec.id, 'goal-approved', approval))).toThrow(/never approved/);
  } finally {
    close();
  }
});

it('goal show says "không có khoá test" for a Goal that pinned no setup, and shows the pin otherwise', async () => {
  const { invoke, out, approveSetup, approve } = await project();
  await approve();
  out.length = 0;
  await invoke('goal', 'show', spec.id);
  expect(out).toEqual([
    `${spec.id}\tapproved\t${spec.outcome}`,
    'không có setup',
    expect.stringContaining('không có khoá test') as unknown,
  ]);
  approveSetup(1, 'a');
  const second = await project();
  second.approveSetup(1, 'a');
  await second.approve();
  second.out.length = 0;
  await second.invoke('goal', 'show', spec.id);
  expect(second.out[1]).toBe('setup v1');
});
