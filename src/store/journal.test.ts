import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite.js';
import { ProjectJournal } from './journal.js';
import { spec } from '../domain/fixtures.test-support.js';
import { initProject } from '../app/init-project.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

it('records Goal state and its readable Git history together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-journal-')); dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  const store = SqliteStore.open(join(dir, '.apos', 'state.sqlite'));
  const journal = new ProjectJournal(dir, store);
  const event = { id: 'EV-1', goalId: spec.id, type: 'goal-drafted' as const, data: spec, at: '2026-11-07T00:00:00.000Z' };
  await journal.append(event);
  expect(journal.getGoal(spec.id)?.status).toBe('draft');
  expect(readFileSync(join(dir, '.apos', 'goals', spec.id, 'goal.md'), 'utf8')).toContain('check in');
  expect(readFileSync(join(dir, '.apos', 'goals', spec.id, 'events.jsonl'), 'utf8')).toContain('EV-1');
  const history = execFileSync('git', ['-C', dir, 'show', '--pretty=format:', '--name-only', 'HEAD'], { encoding: 'utf8' });
  expect(history).toContain('.apos/goals/GOAL-001/events.jsonl');
  expect(history).not.toContain('state.sqlite');
  store.close();
});

it('does not commit an event that fails the approval gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-journal-')); dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  const store = SqliteStore.open(join(dir, '.apos', 'state.sqlite'));
  const journal = new ProjectJournal(dir, store);
  const invalid = { id: 'EV-2', goalId: spec.id, type: 'goal-approved' as const, at: '2026-11-07T00:00:00.000Z' };
  expect(() => journal.append(invalid)).toThrow(/Goal does not exist/);
  expect(journal.getGoal(spec.id)).toBeUndefined();
  expect(() => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: 'pipe' })).toThrow();
  store.close();
});
