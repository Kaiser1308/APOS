import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectLog, projectLogPath, readProjectEvents } from './project-log.js';
import { EventLog } from './event-log.js';
import { ReadOnlyJournal } from './readonly-journal.js';
import type { ProjectEvent } from '../domain/setup-history.js';

const dirs: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-project-log-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'events'), { recursive: true });
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);
let n = 0;
const probed = (sha256: string, ok = true): ProjectEvent => ({
  id: `p${++n}`,
  type: 'setup-probed',
  at: '2026-11-22T00:00:00.000Z',
  data: { sha256, commit: COMMIT, ok, results: [{ part: 'app', layer: 'L1', tool: 'vitest', ok, reason: 'ok' }] },
});
const approved = (sha256: string, version: number): ProjectEvent => ({
  id: `a${++n}`,
  type: 'setup-approved',
  at: '2026-11-22T00:00:00.000Z',
  data: { version, sha256, commit: COMMIT, confirmation: { by: 'human' } },
});

describe('project log', () => {
  it('replays probes and approvals; versions count up from 1', () => {
    const log = new ProjectLog(home());
    log.append(probed(A));
    log.append(approved(A, 1));
    log.append(probed(B));
    log.append(approved(B, 2));
    const history = log.history();
    expect(history.approvals.map(item => item.version)).toEqual([1, 2]);
    expect(history.latest?.sha256).toBe(B);
    expect(history.probes).toHaveLength(2);
  });
  it('refuses an approval with no passing probe of that sha256', () => {
    const log = new ProjectLog(home());
    expect(() => log.append(approved(A, 1))).toThrow(/without a passing probe/);
    log.append(probed(A, false));
    expect(() => log.append(approved(A, 1))).toThrow(/without a passing probe/);
    log.append(probed(B));
    expect(() => log.append(approved(A, 1))).toThrow(/without a passing probe/);
    expect(log.read()).toHaveLength(2);
  });
  it('refuses a version that skips or repeats', () => {
    const log = new ProjectLog(home());
    log.append(probed(A));
    expect(() => log.append(approved(A, 2))).toThrow(/version 1/);
    log.append(approved(A, 1));
    expect(() => log.append(approved(A, 1))).toThrow(/version 2/);
  });
  it('refuses a malformed payload and ignores a re-sent event id', () => {
    const log = new ProjectLog(home());
    expect(() => log.append({ ...probed(A), data: { sha256: 'short' } })).toThrow();
    const event = probed(A);
    log.append(event);
    log.append(event);
    expect(log.read()).toHaveLength(1);
  });
  it('detects an edited line as tampering', () => {
    const dir = home();
    const log = new ProjectLog(dir);
    log.append(probed(A));
    log.append(approved(A, 1));
    const path = projectLogPath(dir);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"version":1', '"version":7'));
    expect(() => log.read()).toThrow(/_project was modified at line 2/);
    expect(() => new ProjectLog(dir).append(probed(B))).toThrow(/modified/);
  });
  it('drops a torn final line on write but not on a read-only peek', () => {
    const dir = home();
    const log = new ProjectLog(dir);
    log.append(probed(A));
    const path = projectLogPath(dir);
    appendFileSync(path, '{"event":{"id":"half');
    const size = readFileSync(path).length;
    expect(readProjectEvents(dir)).toHaveLength(1);
    expect(readFileSync(path).length).toBe(size);
    expect(log.read()).toHaveLength(1);
    expect(readFileSync(path).length).toBeLessThan(size);
  });
  it('is not mistaken for a Goal log, and the read-only journal exposes it', () => {
    const dir = home();
    new ProjectLog(dir).append(probed(A));
    expect(new EventLog(dir).goals()).toEqual([]);
    const journal = new ReadOnlyJournal(dir);
    expect(journal.goalIds()).toEqual([]);
    expect(journal.projectEvents()).toHaveLength(1);
  });
  it('reads as empty when there is no stream yet', () => {
    expect(readProjectEvents(home())).toEqual([]);
    expect(new ProjectLog(home()).history()).toEqual({ probes: [], approvals: [] });
  });
});
