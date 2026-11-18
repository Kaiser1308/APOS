import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { spec, proposal, gateReport, approval } from '../domain/fixtures.test-support.js';
import { initProject } from './init-project.js';
import { MergeService } from './merge.js';
import type { GoalEventType } from '../domain/transitions.js';

// These tests build scratch Git repos and spawn many git processes; a loaded parallel run on Windows measured 3-5x slower than alone, past the default.
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

it('merges only the gated commit, only after the Human authorizes that one merge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-merge-'));
  dirs.push(dir);
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  await initProject(dir);
  const target = git(['branch', '--show-current']);
  git(['switch', '-q', '-c', 'feature']);
  writeFileSync(join(dir, 'feature.txt'), 'done');
  git(['add', 'feature.txt']);
  git(['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '-qm', 'feature']);
  const source = git(['rev-parse', 'HEAD']);
  git(['switch', '-q', target]);
  const store = SqliteStore.open(join(dir, '.apos', 'state.sqlite'));
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    store.append({ id: `EV-${++n}`, goalId: spec.id, type, data, at: '2026-11-07T00:00:00.000Z' });
  add('goal-drafted', spec);
  add('goal-approved', approval);
  add('goal-selected');
  add('proposal-drafted', proposal);
  add('proposal-approved');
  add('execution-started', { runId: 'run_1' });
  // The owner reports a different commit than the one the controller gated: only the gated one may merge.
  const stale = '0'.repeat(40);
  add('evidence-submitted', {
    acceptanceId: 'AC-1',
    result: 'pass',
    command: 'npm test',
    artifactRef: 'log:goal',
    commitRef: stale,
  });
  add('gate-recorded', gateReport(source));
  add('verified');
  const service = new MergeService(store);
  expect(() => service.merge(spec.id, dir, source, target)).toThrow(/Human merge authorization/);
  service.authorize(spec.id, target, 'human');
  expect(() => service.merge(spec.id, dir, stale, target)).toThrow(/controller gate verified/i);
  expect(() => service.merge(spec.id, dir, source, 'release')).toThrow(/covers/);
  const merged = service.merge(spec.id, dir, source, target);
  expect(merged).toBe(git(['rev-parse', 'HEAD']));
  expect(git(['merge-base', '--is-ancestor', source, merged])).toBe('');
  expect(store.getGoal(spec.id)?.merge?.sourceRef).toBe(source);
  expect(() => service.merge(spec.id, dir, source, target)).toThrow(/authorization/i);
  expect(() => service.authorize(spec.id, target, 'human')).toThrow(/prior authorization/);
  store.close();
});
