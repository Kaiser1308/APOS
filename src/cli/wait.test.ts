import { newEvent } from '../app/events.js';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { initProject } from '../app/init-project.js';
import { ProjectJournal } from '../store/journal.js';
import { approval, proposal, sourceText, spec } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
afterEach(() => {
  process.exitCode = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function setupProject(withControllerHeartbeat = true) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-wait-repo-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-wait-home-'));
  dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  if (withControllerHeartbeat) {
    writeFileSync(
      join(home, 'controller.heartbeat'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
  }
  const opened = ProjectJournal.open(dir, home, newEvent);
  let n = 0;
  const baseAt = Date.parse('2026-11-18T05:00:00.000Z');
  const add = (type: GoalEventType, data?: unknown, goalId = spec.id) =>
    opened.journal.append({
      id: `EV-${++n}`,
      goalId,
      type,
      data,
      at: new Date(baseAt + n * 1000).toISOString(),
    });
  opened.journal.appendWithSource(
    {
      id: `EV-${++n}`,
      goalId: spec.id,
      type: 'goal-drafted',
      data: spec,
      at: new Date(baseAt + n * 1000).toISOString(),
    },
    sourceText,
  );
  return { dir, home, opened, add };
}

// Scratch-repo setup spawns many git processes; under a loaded parallel run it takes several times longer.
describe('apos inbox --wait and apos goal wait (#28)', { timeout: 60_000 }, () => {
  it('returns immediately for Gate A waiting, and with --since waits for a new event instead of repeating', async () => {
    const { dir, home, opened, add } = await setupProject(true);
    const out1: string[] = [];
    await runCli(['--repo', dir, 'inbox', '--wait', '--timeout', '1s'], {
      home,
      write: line => out1.push(line),
    });
    expect(out1.some(line => line.includes('GOAL-001') && line.includes('awaiting-approval'))).toBe(true);
    const cursorLine = out1.find(line => line.startsWith('cursor: '))!;
    expect(cursorLine).toBeDefined();
    const cursor = cursorLine.slice('cursor: '.length).trim();

    // Advance the Goal to executing, get the updated cursor after Gate B/plan, then wait for a new notice
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    add('execution-started', { runId: 'r', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir });

    // Now start waiting with --since cursor; append a new notice after 80ms (no git subprocess needed)
    const out2: string[] = [];
    setTimeout(() => {
      add('human-notified', { kind: 'owner-idle', goalId: spec.id, dispatchId: 'ctx_1', idleMinutes: 15 });
      opened.close();
    }, 80);

    const started = Date.now();
    await runCli(['--repo', dir, 'inbox', '--wait', '--since', cursor, '--timeout', '5s'], {
      home,
      write: line => out2.push(line),
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(out2.some(line => line.includes('awaiting-approval'))).toBe(false);
    expect(out2.some(line => line.includes('owner-idle'))).toBe(true);
  });

  it('prints nothing while waiting and exits with code 2 and a Goal summary on timeout', async () => {
    const { dir, home, opened, add } = await setupProject(true);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    add('execution-started', { runId: 'r', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir });
    opened.close();

    const out: string[] = [];
    const started = Date.now();
    await runCli(['--repo', dir, 'inbox', '--wait', '--timeout', '150ms'], {
      home,
      write: line => out.push(line),
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(process.exitCode).toBe(2);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/timeout.*GOAL-001:executing/i);
  });

  it('warns immediately when no controller watch is running', async () => {
    const { dir, home, opened, add } = await setupProject(false);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    add('execution-started', { runId: 'r', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir });
    opened.close();

    const out: string[] = [];
    const err: string[] = [];
    await runCli(['--repo', dir, 'inbox', '--wait', '--timeout', '120ms'], {
      home,
      write: line => out.push(line),
      writeError: line => err.push(line),
    });
    expect(err[0]).toMatch(/warning:.*controller watch/i);
    expect(out.some(line => /warning:/i.test(line))).toBe(false);
    expect(process.exitCode).toBe(2);
  });

  it('keeps stdout pure JSON with --json when no controller runs and the wait times out', async () => {
    const { dir, home, opened, add } = await setupProject(false);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    add('execution-started', { runId: 'r', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir });
    opened.close();

    const out: string[] = [];
    const err: string[] = [];
    await runCli(['--repo', dir, 'inbox', '--wait', '--json', '--timeout', '120ms'], {
      home,
      write: line => out.push(line),
      writeError: line => err.push(line),
    });
    expect(err.some(line => /warning:.*controller watch/i.test(line))).toBe(true);
    const parsed = JSON.parse(out.join('\n')) as { timeout: boolean; items: unknown[] };
    expect(parsed.timeout).toBe(true);
    expect(parsed.items).toEqual([]);
    expect(process.exitCode).toBe(2);
  });

  it('apos goal wait blocks until the Goal reaches a target state or gets a notice', async () => {
    const { dir, home, opened, add } = await setupProject(true);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    add('execution-started', { runId: 'r', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir });

    setTimeout(() => {
      add('verified');
      opened.close();
    }, 80);

    const out: string[] = [];
    await runCli(['--repo', dir, 'goal', 'wait', spec.id, '--until', 'verified,closed', '--timeout', '3s'], {
      home,
      write: line => out.push(line),
    });
    expect(process.exitCode).toBe(0);
    expect(out.some(line => line.includes('GOAL-001') && line.includes('verified'))).toBe(true);
  });
});
