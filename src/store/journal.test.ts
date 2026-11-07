import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite.js';
import { ProjectJournal } from './journal.js';
import { ProjectHistory } from './project-history.js';
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
  expect(execFileSync('git', ['-C', dir, 'show', '--pretty=format:', '--name-only', 'HEAD'], { encoding: 'utf8' })).not.toContain('events.jsonl');
  store.close();
});

it('saves each Work Package spec inside its Goal history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-journal-')); dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  const store = SqliteStore.open(join(dir, '.apos', 'state.sqlite'));
  const journal = new ProjectJournal(dir, store);
  const at = '2026-11-07T00:00:00.000Z';
  const add = (id: string, type: import('../domain/transitions.js').GoalEventType, data?: unknown) => journal.append({ id, goalId: spec.id, type, data, at });
  add('EV-1', 'goal-drafted', spec); add('EV-2', 'goal-approved'); add('EV-3', 'goal-selected');
  add('EV-4', 'proposal-drafted', { id: 'EXEC-001', version: 1, goalId: spec.id, goalVersion: 1, mode: 'multi-wp', approach: 'split outcomes', risks: [], acceptanceMapping: [{ acceptanceId: 'AC-1', verification: 'test' }], verificationStrategy: 'integration' });
  add('EV-5', 'package-added', { id: 'WP-01', goalId: spec.id, goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)'], acceptance: [{ id: 'WP-AC-1', text: 'scan', goalAcceptanceId: 'AC-1' }], integration: 'Lead integrates' });
  expect(readFileSync(join(dir, '.apos', 'goals', spec.id, 'packages', 'WP-01.md'), 'utf8')).toContain('QR intake');
  store.close();
});

it('rebuilds a missing SQLite index from committed Goal events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-journal-')); dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  const event = { id: 'EV-crash', goalId: spec.id, type: 'goal-drafted' as const, data: spec, at: '2026-11-07T00:00:00.000Z' };
  new ProjectHistory().recordSync(dir, spec.id, event);
  const store = SqliteStore.open(join(dir, '.apos', 'state.sqlite'));
  const journal = new ProjectJournal(dir, store);
  expect(journal.getGoal(spec.id)?.spec.outcome).toBe(spec.outcome);
  expect(store.hasEvent('EV-crash')).toBe(true);
  store.close();
});
