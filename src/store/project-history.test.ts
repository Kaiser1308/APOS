import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectHistory } from './project-history.js';
import { spec } from '../domain/fixtures.test-support.js';

const dirs: string[] = [];
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-history-')); dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'APOS Test']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'apos-test@example.invalid']);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

describe('project history', () => {
  it('records a readable event and does not include unrelated staged or dirty files', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'user.txt'), 'personal work');
    execFileSync('git', ['-C', dir, 'add', 'user.txt']);
    const event = { id: 'EV-1', goalId: spec.id, type: 'goal-drafted' as const, data: spec, at: '2026-11-07T00:00:00.000Z' };
    const history = new ProjectHistory();
    const first = await history.record(dir, spec.id, event, [{ path: 'goal.md', content: '# QR check-in\n' }]);
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(dir, '.apos', 'goals', spec.id, 'events.jsonl'), 'utf8')).toContain('EV-1');
    expect(execFileSync('git', ['-C', dir, 'show', '--pretty=format:', '--name-only', 'HEAD'], { encoding: 'utf8' })).not.toContain('user.txt');
    expect(execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })).toContain('user.txt');
    const second = await history.record(dir, spec.id, event);
    expect(second.commit).toBe(first.commit);
    expect(readFileSync(join(dir, '.apos', 'goals', spec.id, 'events.jsonl'), 'utf8').match(/EV-1/g)).toHaveLength(1);
  });
  it('rejects a non-Git project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-nongit-')); dirs.push(dir);
    await expect(new ProjectHistory().record(dir, spec.id, { id: 'EV-1', goalId: spec.id, type: 'goal-drafted', data: spec, at: '2026-11-07T00:00:00.000Z' })).rejects.toThrow(/Git/);
  });
  it('does not silently commit an uncommitted history tail after an interruption', async () => {
    const dir = repo();
    const history = new ProjectHistory();
    const first = { id: 'EV-1', goalId: spec.id, type: 'goal-drafted' as const, data: spec, at: '2026-11-07T00:00:00.000Z' };
    await history.record(dir, spec.id, first);
    const eventFile = join(dir, '.apos', 'goals', spec.id, 'events.jsonl');
    writeFileSync(eventFile, `${readFileSync(eventFile, 'utf8')}${JSON.stringify({ ...first, id: 'EV-ghost', type: 'goal-approved' })}\n`);
    await expect(history.record(dir, spec.id, { ...first, id: 'EV-2', type: 'goal-approved' })).rejects.toThrow(/Uncommitted APOS Goal history/);
    expect(readFileSync(eventFile, 'utf8')).toContain('EV-ghost');
  });
  it('recovers a stale lock left by a dead process', async () => {
    const dir = repo();
    const lock = join(dir, '.apos', '.history.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, token: 'dead' }));
    utimesSync(lock, new Date(0), new Date(0));
    const event = { id: 'EV-1', goalId: spec.id, type: 'goal-drafted' as const, data: spec, at: '2026-11-07T00:00:00.000Z' };
    await new ProjectHistory().record(dir, spec.id, event);
    expect(existsSync(lock)).toBe(false);
  });
});
