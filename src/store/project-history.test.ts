import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitGoalDocuments, withLock } from './project-history.js';
import { EventLog, controllerHome } from './event-log.js';
import { spec } from '../domain/fixtures.test-support.js';

const dirs: string[] = [];
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const repo = () => {
  const dir = temp('apos-history-');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'APOS Test']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'apos-test@example.invalid']);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
const event = (id: string, type: 'goal-drafted' | 'goal-approved' = 'goal-drafted') => ({ id, goalId: spec.id, type, data: type === 'goal-drafted' ? spec : undefined, at: '2026-11-07T00:00:00.000Z' });

describe('goal documents in the managed repo', () => {
  it('commits only its own documents, leaving the user staged and dirty files alone', () => {
    const dir = repo();
    writeFileSync(join(dir, 'user.txt'), 'personal work');
    execFileSync('git', ['-C', dir, 'add', 'user.txt']);
    const commit = commitGoalDocuments(dir, spec.id, [{ path: 'goal.md', content: '# QR check-in\n' }], 'apos: test');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync('git', ['-C', dir, 'show', '--pretty=format:', '--name-only', 'HEAD'], { encoding: 'utf8' })).not.toContain('user.txt');
    expect(execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })).toContain('user.txt');
    expect(commitGoalDocuments(dir, spec.id, [{ path: 'goal.md', content: '# QR check-in\n' }], 'apos: same')).toBeUndefined();
  });
  it('rejects a non-Git project and paths outside the Goal folder', () => {
    expect(() => commitGoalDocuments(temp('apos-nongit-'), spec.id, [], 'x')).toThrow(/Git/);
    expect(() => commitGoalDocuments(repo(), spec.id, [{ path: '../escape.md', content: 'x' }], 'x')).toThrow(/Invalid document path/);
  });
  it('recovers a stale lock left by a dead process', () => {
    const dir = temp('apos-lock-');
    const lock = join(dir, '.apos.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, token: 'dead' }));
    utimesSync(lock, new Date(0), new Date(0));
    expect(withLock(dir, () => 'ran')).toBe('ran');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('controller event log', () => {
  it('lives outside the managed repo and is keyed by the repo path', () => {
    const dir = repo();
    const home = controllerHome(dir, temp('apos-root-'));
    expect(home.toLowerCase().startsWith(dir.toLowerCase())).toBe(false);
    expect(controllerHome(dir.toUpperCase(), join(home, '..', '..'))).toBe(home);
  });
  it('appends hash-chained events and reads them back in order', () => {
    const log = new EventLog(temp('apos-log-'));
    log.append(event('EV-1')); log.append(event('EV-2', 'goal-approved'));
    expect(log.read(spec.id).map(item => item.id)).toEqual(['EV-1', 'EV-2']);
    expect(log.goals()).toEqual([spec.id]);
  });
  it('drops a torn final line left by a crash mid-write and keeps appending', () => {
    const dir = temp('apos-log-');
    const log = new EventLog(dir);
    log.append(event('EV-1'));
    appendFileSync(join(dir, 'events', `${spec.id}.jsonl`), '{"event":{"id":"EV-2"');
    expect(log.read(spec.id).map(item => item.id)).toEqual(['EV-1']);
    log.append(event('EV-2', 'goal-approved'));
    expect(log.read(spec.id).map(item => item.id)).toEqual(['EV-1', 'EV-2']);
  });
  it('reports an edited or forged event instead of trusting it', () => {
    const dir = temp('apos-log-');
    const log = new EventLog(dir);
    log.append(event('EV-1')); log.append(event('EV-2', 'goal-approved'));
    const path = join(dir, 'events', `${spec.id}.jsonl`);
    const [first, second] = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${first}\n${second.replace('goal-approved', 'goal-selected')}\n`);
    expect(() => log.read(spec.id)).toThrow(/modified at line 2/);
    const forged = JSON.stringify({ event: event('EV-3', 'goal-approved'), prev: 'f'.repeat(64), hash: 'f'.repeat(64) });
    writeFileSync(path, `${first}\n${forged}\n`);
    expect(() => log.read(spec.id)).toThrow(/modified at line 2/);
  });
});
