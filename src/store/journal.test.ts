import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectJournal } from './journal.js';
import { spec, proposal, sourceText, approval } from '../domain/fixtures.test-support.js';
import { parseProjectSetup } from '../domain/project-setup.js';
import { yamlCodec } from '../domain/setup-codec.js';
import { initProject } from '../app/init-project.js';
import { newEvent } from '../app/events.js';
import { sourceDigest } from '../domain/gate.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const at = '2026-11-07T00:00:00.000Z';

async function project() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-journal-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-journal-home-'));
  dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const opened = ProjectJournal.open(dir, home, newEvent);
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    opened.journal.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at });
  const draft = () =>
    opened.journal.appendWithSource(
      { id: `EV-${++n}`, goalId: spec.id, type: 'goal-drafted', data: spec, at },
      sourceText,
    );
  return { dir, home, git, add, draft, ...opened };
}

it('keeps events in the controller home and commits nothing to the repo before a milestone', async () => {
  const { dir, home, git, draft, journal, close } = await project();
  const before = git('rev-parse', 'HEAD');
  draft();
  expect(journal.getGoal(spec.id)?.status).toBe('draft');
  expect(existsSync(join(home, 'events', `${spec.id}.jsonl`))).toBe(true);
  expect(existsSync(join(dir, '.apos', 'goals', spec.id, 'events.jsonl'))).toBe(false);
  expect(git('rev-parse', 'HEAD')).toBe(before);
  expect(journal.currentSourceDigest(spec.id)).toBe(spec.source.sha256);
  close();
});

it('commits the readable Goal record with its source at approval', async () => {
  const { dir, git, draft, add, close } = await project();
  draft();
  add('goal-approved', approval);
  expect(git('log', '-1', '--format=%s')).toBe(`apos: ${spec.id} goal-approved`);
  const files = git('show', '--pretty=format:', '--name-only', 'HEAD');
  expect(files).toContain(`.apos/goals/${spec.id}/goal.md`);
  expect(files).toContain(`.apos/goals/${spec.id}/source.md`);
  expect(readFileSync(join(dir, '.apos', 'goals', spec.id, 'source.md'), 'utf8')).toBe(sourceText);
  expect(readFileSync(join(dir, '.apos', 'goals', spec.id, 'goal.md'), 'utf8')).not.toMatch(
    /maxSpend|appetite|maxWallMinutes/,
  );
  close();
});

it('does not log an event that fails its transition', async () => {
  const { home, journal, close } = await project();
  expect(() => journal.append({ id: 'EV-x', goalId: spec.id, type: 'goal-approved', at })).toThrow(
    /Goal does not exist/,
  );
  expect(existsSync(join(home, 'events', `${spec.id}.jsonl`))).toBe(false);
  close();
});

it('preserves the existing source, event log and Goal when a duplicate draft is rejected', async () => {
  const { home, journal, draft, close } = await project();
  try {
    draft();
    const snapshot = join(home, 'sources', spec.id, 'v1.md');
    const log = join(home, 'events', `${spec.id}.jsonl`);
    const beforeLog = readFileSync(log, 'utf8');
    const replacement = 'A different brief for the same goal.\n';
    const duplicate = { ...spec, source: { ...spec.source, sha256: sourceDigest(replacement) } };
    expect(() =>
      journal.appendWithSource(
        { id: 'EV-duplicate', goalId: spec.id, type: 'goal-drafted', data: duplicate, at },
        replacement,
      ),
    ).toThrow(/Goal already exists/);
    expect(readFileSync(snapshot, 'utf8')).toBe(sourceText);
    expect(readFileSync(log, 'utf8')).toBe(beforeLog);
    expect(journal.currentSourceDigest(spec.id)).toBe(spec.source.sha256);
    expect(journal.getGoal(spec.id)?.spec.source.sha256).toBe(spec.source.sha256);
  } finally {
    close();
  }
});

it('does not overwrite a conflicting orphan source snapshot after an interrupted write', async () => {
  const { home, journal, close } = await project();
  try {
    const dir = join(home, 'sources', spec.id);
    mkdirSync(dir, { recursive: true });
    const snapshot = join(dir, 'v1.md');
    writeFileSync(snapshot, 'earlier incomplete source');
    expect(() =>
      journal.appendWithSource({ id: 'EV-orphan', goalId: spec.id, type: 'goal-drafted', data: spec, at }, sourceText),
    ).toThrow(/source snapshot/i);
    expect(readFileSync(snapshot, 'utf8')).toBe('earlier incomplete source');
    expect(journal.getGoal(spec.id)).toBeUndefined();
    expect(existsSync(join(home, 'events', `${spec.id}.jsonl`))).toBe(false);
  } finally {
    close();
  }
});

it('can retry a draft when an identical orphan snapshot already exists', async () => {
  const { home, journal, close } = await project();
  try {
    const dir = join(home, 'sources', spec.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'v1.md'), sourceText);
    journal.appendWithSource({ id: 'EV-retry', goalId: spec.id, type: 'goal-drafted', data: spec, at }, sourceText);
    expect(journal.currentSourceDigest(spec.id)).toBe(spec.source.sha256);
    expect(journal.getGoal(spec.id)?.status).toBe('draft');
  } finally {
    close();
  }
});

it('rebuilds a stale index under the lock before rejecting a duplicate source', async () => {
  const { home, journal, draft, close } = await project();
  try {
    draft();
    const db = new DatabaseSync(join(home, 'state.sqlite'));
    try {
      db.exec('DELETE FROM events');
    } finally {
      db.close();
    }
    const replacement = 'A stale-index replacement.\n';
    const duplicate = { ...spec, source: { ...spec.source, sha256: sourceDigest(replacement) } };
    expect(() =>
      journal.appendWithSource(
        { id: 'EV-stale', goalId: spec.id, type: 'goal-drafted', data: duplicate, at },
        replacement,
      ),
    ).toThrow(/Goal already exists/);
    expect(readFileSync(join(home, 'sources', spec.id, 'v1.md'), 'utf8')).toBe(sourceText);
    expect(journal.currentSourceDigest(spec.id)).toBe(spec.source.sha256);
  } finally {
    close();
  }
});

it('replays an already recorded draft without adding an event or changing its source', async () => {
  const { home, journal, close } = await project();
  try {
    const event = { id: 'EV-replayed', goalId: spec.id, type: 'goal-drafted' as const, data: spec, at };
    journal.appendWithSource(event, sourceText);
    const log = join(home, 'events', `${spec.id}.jsonl`);
    const before = readFileSync(log, 'utf8');
    journal.appendWithSource(event, sourceText);
    expect(readFileSync(log, 'utf8')).toBe(before);
    expect(journal.currentSourceDigest(spec.id)).toBe(spec.source.sha256);
  } finally {
    close();
  }
});

it('does not create a source snapshot for a rejected revision', async () => {
  const { home, journal, draft, close } = await project();
  try {
    draft();
    const invalid = { ...spec, version: 1 };
    expect(() =>
      journal.appendWithSource(
        { id: 'EV-bad-revision', goalId: spec.id, type: 'goal-revised', data: invalid, at },
        sourceText,
      ),
    ).toThrow(/revision must advance version/i);
    expect(readFileSync(join(home, 'sources', spec.id, 'v1.md'), 'utf8')).toBe(sourceText);
    expect(journal.getGoal(spec.id)?.spec.version).toBe(1);
  } finally {
    close();
  }
});

it('rebuilds a lost SQLite index from the controller log', async () => {
  const { dir, home, draft, add, close } = await project();
  draft();
  add('goal-approved', approval);
  add('goal-selected');
  close();
  rmSync(join(home, 'state.sqlite'), { force: true });
  rmSync(join(home, 'state.sqlite-wal'), { force: true });
  rmSync(join(home, 'state.sqlite-shm'), { force: true });
  const reopened = ProjectJournal.open(dir, home);
  expect(reopened.journal.getGoal(spec.id)?.status).toBe('selected');
  reopened.close();
});

it('ignores Goal events an owner commits into the repo', async () => {
  const { dir, git, draft, add, journal, close } = await project();
  draft();
  add('goal-approved', approval);
  add('goal-selected');
  add('proposal-drafted', proposal);
  add('proposal-approved');
  const forged = { id: 'EV-forged', goalId: spec.id, type: 'verified', at };
  mkdirSync(join(dir, '.apos', 'goals', spec.id), { recursive: true });
  writeFileSync(join(dir, '.apos', 'goals', spec.id, 'events.jsonl'), `${JSON.stringify(forged)}\n`);
  git('add', '-A');
  git('-c', 'user.name=Owner', '-c', 'user.email=o@local.invalid', 'commit', '-qm', 'forge');
  close();
  const reopened = ProjectJournal.open(dir, mkdtempSync(join(tmpdir(), 'apos-journal-other-')));
  expect(reopened.journal.getGoal(spec.id)).toBeUndefined();
  reopened.close();
  expect(journal).toBeDefined();
});

it('imports an APOS v1 history kept in the repo, once, and skips one that no longer fits the contract', async () => {
  const { dir, home, git, close } = await project();
  close();
  const legacy = [
    { id: 'L-1', goalId: spec.id, type: 'goal-drafted', data: spec, at },
    { id: 'L-2', goalId: spec.id, type: 'goal-approved', data: approval, at },
  ];
  const goalDir = join(dir, '.apos', 'goals', spec.id);
  mkdirSync(goalDir, { recursive: true });
  writeFileSync(join(goalDir, 'events.jsonl'), legacy.map(item => JSON.stringify(item)).join('\n') + '\n');
  writeFileSync(join(goalDir, 'source.md'), sourceText);
  const oldDir = join(dir, '.apos', 'goals', 'GOAL-OLD');
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(
    join(oldDir, 'events.jsonl'),
    JSON.stringify({
      id: 'O-1',
      goalId: 'GOAL-OLD',
      type: 'goal-drafted',
      data: { id: 'GOAL-OLD', version: 1, outcome: 'v1 shape' },
      at,
    }) + '\n',
  );
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'v1 history');
  const opened = ProjectJournal.open(dir, home);
  const result = opened.journal.importLegacy();
  expect(result.imported).toEqual([spec.id]);
  expect(result.skipped.map(item => item.goalId)).toEqual(['GOAL-OLD']);
  expect(opened.journal.getGoal(spec.id)?.status).toBe('approved');
  expect(opened.journal.importLegacy().imported).toEqual([]);
  opened.close();
});

it('refuses to append an orchestration event, or anything at all to a legacy Goal, and leaves the log alone', async () => {
  const { draft, journal, close } = await project();
  draft();
  expect(() => journal.append({ id: 'EV-legacy', goalId: spec.id, type: 'lead-started' as GoalEventType, at })).toThrow(
    /not an APOS v3 event/,
  );
  close();
  // A log recorded by the old APOS replays, shows as legacy, and takes no new events.
  const legacyHome = mkdtempSync(join(tmpdir(), 'apos-journal-legacy-'));
  dirs.push(legacyHome);
  const events = join(legacyHome, 'events');
  mkdirSync(events, { recursive: true });
  const fixtures = join(import.meta.dirname, 'fixtures', 'replay', 'lead', 'events');
  writeFileSync(join(events, 'GOAL-001.jsonl'), readFileSync(join(fixtures, 'GOAL-001.jsonl')));
  const repo = mkdtempSync(join(tmpdir(), 'apos-journal-legacy-repo-'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q', repo]);
  const opened = ProjectJournal.open(repo, legacyHome, newEvent);
  const before = readFileSync(join(events, 'GOAL-001.jsonl'), 'utf8');
  expect(opened.journal.getGoal('GOAL-001')?.status).toBe('legacy');
  expect(() =>
    opened.journal.append({ id: 'EV-new', goalId: 'GOAL-001', type: 'decision-logged', data: { note: 'x' }, at }),
  ).toThrow(/legacy Goal.*read-only/);
  expect(() =>
    opened.journal.appendWithSource(
      { id: 'EV-legacy-revise', goalId: spec.id, type: 'goal-revised', data: { ...spec, version: 2 }, at },
      sourceText,
    ),
  ).toThrow(/legacy Goal.*read-only/);
  expect(existsSync(join(legacyHome, 'sources', spec.id, 'v2.md'))).toBe(false);
  expect(readFileSync(join(events, 'GOAL-001.jsonl'), 'utf8')).toBe(before);
  opened.close();
});

it('keeps setup probes and approvals in the _project stream, which survives reopening and is not a Goal', async () => {
  const { dir, home, journal, close } = await project();
  const sha256 = 'd'.repeat(64);
  const commit = 'e'.repeat(40);
  journal.appendProjectEvent({
    id: 'PE-1',
    type: 'setup-probed',
    at,
    data: { sha256, commit, ok: true, results: [] },
  });
  journal.appendProjectEvent({
    id: 'PE-2',
    type: 'setup-approved',
    at,
    data: { version: 1, sha256, commit, confirmation: { by: 'human' } },
  });
  expect(journal.setupHistory().latest?.version).toBe(1);
  expect(journal.listGoals()).toEqual([]);
  close();
  const reopened = ProjectJournal.open(dir, home);
  expect(reopened.journal.projectEvents().map(item => item.id)).toEqual(['PE-1', 'PE-2']);
  reopened.close();
});

it('writes a v2 setup with no parts when initializing a project', async () => {
  const { dir, close } = await project();
  expect(parseProjectSetup(readFileSync(join(dir, '.apos', 'project.yaml'), 'utf8'), yamlCodec)).toMatchObject({
    version: 2,
    setup: { parts: {} },
  });
  close();
});
