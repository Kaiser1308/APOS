import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeBase, extractStartedRef, terminalWorktree, interpretWorkerShow, OrcaRuntime, parseOrcaResult } from './orca.js';
import { DEFAULT_PROFILES } from './brief.js';

describe('Orca adapter result', () => {
  it('rejects an unknown or failed response rather than claiming a dispatch', () => {
    expect(() => parseOrcaResult('{"ok":false,"result":{}}')).toThrow();
    expect(() => parseOrcaResult('not json')).toThrow();
  });
});

it('registers an unmanaged project before starting its Lead, in its own worktree at an exact base', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime((args) => {
    calls.push(args);
    if (args[0] === 'repo') return { repo: { id: 'repo_1' } };
    if (args[1] === 'run-create') return { run: { id: 'run_1' } };
    return { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', effects: [] };
  }, () => 'a'.repeat(40), DEFAULT_PROFILES, () => 'd'.repeat(64));
  const ref = await runtime.startLead({ repoPath: 'C:/project', goalId: 'GOAL-001', goalVersion: 1, idempotencyKey: 'key-1' });
  expect(calls[0]).toEqual(['repo', 'add', '--path', 'C:/project']);
  expect(calls.find(args => args[1] === 'run-create')).toContain('APOS GOAL-001 lead v1 key key-1');
  const start = calls.find(args => args[1] === 'worker-start')!;
  expect(start).toEqual(expect.arrayContaining(['--worktree', 'new-top-level', '--base-branch', 'a'.repeat(40), '--agent', 'codex', '--model', 'gpt-6.1-terra']));
  expect(start[start.indexOf('--spec') + 1]).toContain('APOS Lead for Goal v1');
  expect(ref).toMatchObject({ dispatchId: 'ctx_1', baseCommit: 'a'.repeat(40), requested: { agent: 'codex', model: 'gpt-6.1-terra' } });
});

it('starts a package Worker in a dedicated Orca worktree', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[0] === 'repo') return { repo: { id: 'repo_1' } };
    if (args[1] === 'run-list') return { runs: [] };
    if (args[1] === 'run-create') return { run: { id: 'run_1' } };
    return { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', effects: [] };
  }, () => 'a'.repeat(40), DEFAULT_PROFILES, () => 'd'.repeat(64));
  const ref = await runtime.startPackage({ repoPath: 'C:/project', idempotencyKey: 'key-1', package: {
    id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)@v1'], acceptance: [{ id: 'WP-AC-1', text: 'scan' }], integration: 'Lead verifies'
  } });
  expect(calls[0]).toEqual(['repo', 'add', '--path', 'C:/project']);
  const start = calls.find(args => args[1] === 'worker-start')!;
  expect(start).toContain('new-top-level');
  expect(start).toContain('path:C:/project');
  expect(start).toContain('a'.repeat(40));
  expect(start.join(' ')).toContain('.apos/goals/GOAL-001/evidence/WP-01-v1-a1.md');
  expect(start.join(' ')).toContain('apos-core: dddddddddddddddd');
  expect(start).toEqual(expect.arrayContaining(['--agent', 'codex', '--model', 'gpt-6.1-terra']));
  expect(ref.owner).toBe('worker');
});

it('shares one Orca Run across independent packages in a dispatch wave', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[0] === 'repo') return { repo: {} };
    if (args[1] === 'run-list') return { runs: [] };
    if (args[1] === 'run-create') return { run: { id: 'run_shared' } };
    return { runId: 'run_shared', taskId: 'task_1', dispatchId: `ctx_${calls.length}`, effects: [] };
  }, () => 'a'.repeat(40), DEFAULT_PROFILES, () => 'd'.repeat(64));
  const a = { id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 1, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token)@v1'], acceptance: [{ id: 'WP-AC-1', text: 'scan' }], integration: 'Lead verifies' };
  const refs = await Promise.all([runtime.startPackage({ package: a, repoPath: 'C:/project', idempotencyKey: 'key-1' }), runtime.startPackage({ package: { ...a, id: 'WP-02' }, repoPath: 'C:/project', idempotencyKey: 'key-2' })]);
  expect(calls.filter(args => args[1] === 'run-create')).toHaveLength(1);
  expect(refs.map(ref => ref.runId)).toEqual(['run_shared', 'run_shared']);
});

it('rebinds an existing Goal Run before dispatching its next package wave', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[0] === 'repo') return { repo: {} };
    if (args[1] === 'run-list') return { runs: [{ id: 'run_shared', objective: 'APOS package Run C:/project GOAL-001 goal v1' }] };
    if (args[1] === 'run-use') return { run: { id: 'run_shared' } };
    return { runId: 'run_shared', taskId: 'task_2', dispatchId: 'ctx_2', effects: [] };
  }, () => 'a'.repeat(40), DEFAULT_PROFILES, () => 'd'.repeat(64));
  await runtime.startPackage({ repoPath: 'C:/project', idempotencyKey: 'key-2', package: { id: 'WP-02', goalId: 'GOAL-001', goalVersion: 1, version: 1, owner: 'worker-b', outcome: 'History', scope: ['history'], exclusions: [], dependencies: [], interfaces: ['history()@v1'], acceptance: [{ id: 'WP-AC-2', text: 'history' }], integration: 'Lead verifies' } });
  expect(calls.find(args => args[1] === 'run-use')).toEqual(['orchestration', 'run-use', '--id', 'run_shared']);
  expect(calls.some(args => args[1] === 'run-create')).toBe(false);
});

it('finds a package dispatch on an older Orca Run page', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[1] === 'run-list' && !args.includes('--cursor')) return { runs: [], nextCursor: 'older' };
    if (args[1] === 'run-list') return { runs: [{ id: 'run_1', objective: 'APOS GOAL-001 WP-01 v1 key lost-key' }] };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task_1', spec: 'Target: C:/project, GOAL-001, WP-01. APOS dispatch key: lost-key.' }] };
    return { dispatch: { id: 'ctx_1', assignee_handle: 'term_1' } };
  });
  expect(await runtime.recoverPackage('lost-key')).toMatchObject({ runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', owner: 'worker', terminal: 'term_1' });
  expect(calls[1]).toEqual(['orchestration', 'run-list', '--cursor', 'older']);
});

it('recovers a package from its shared Goal Run by the original dispatch key', async () => {
  const runtime = new OrcaRuntime(args => {
    if (args[1] === 'run-list') return { runs: [{ id: 'run_shared', objective: 'APOS package Run C:/project GOAL-001 goal v1' }] };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task_2', spec: `Target: C:/project, GOAL-001, WP-02. APOS dispatch key: key-2. APOS base commit: ${'a'.repeat(40)}.` }] };
    if (args[1] === 'dispatch-show') return { dispatch: { id: 'ctx_2', assignee_handle: 'term_2' } };
    return { worker: { worktreeId: 'repo_1::C:/worktree' } };
  });
  expect(await runtime.recoverPackage('key-2')).toMatchObject({ runId: 'run_shared', taskId: 'task_2', dispatchId: 'ctx_2', terminal: 'term_2', worktreeId: 'repo_1::C:/worktree', baseCommit: 'a'.repeat(40) });
});

it('resumes a revised package in its original terminal and worktree', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    return { runId: 'run_1', taskId: 'task_2', dispatchId: 'ctx_2', effects: [{ kind: 'worktree', id: 'repo_1::C:/worktree' }] };
  });
  const ref = await runtime.resumePackage({ package: {
    id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 2, owner: 'worker-a', outcome: 'QR intake', scope: ['scanner'], exclusions: [], dependencies: [], interfaces: ['checkIn(token, device)@v1'], acceptance: [{ id: 'WP-AC-1', text: 'scan' }], integration: 'Lead verifies'
  }, prior: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', owner: 'worker', repoPath: 'C:/project', terminal: 'term_1', worktreeId: 'repo_1::C:/worktree' }, idempotencyKey: 'key-2' });
  const start = calls.find(args => args[1] === 'worker-start')!;
  expect(start).toContain('term_1');
  expect(start).toContain('id:repo_1::C:/worktree');
  expect(ref).toMatchObject({ owner: 'worker', dispatchId: 'ctx_2', worktreeId: 'repo_1::C:/worktree' });
});

it('recovers a phased Solo resume from its known Run without scanning for a new Run', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[1] === 'task-list') return { tasks: [{ id: 'task_2', spec: 'Target: C:/project, APOS Solo Goal. APOS dispatch key: resume-key.' }] };
    return { dispatch: { id: 'ctx_2', assignee_handle: 'term_1' } };
  });
  expect(await runtime.recover('resume-key', 'run_1')).toMatchObject({ runId: 'run_1', dispatchId: 'ctx_2', terminal: 'term_1' });
  expect(calls.some(args => args[1] === 'run-list')).toBe(false);
});

it('treats a live terminal with a settled dispatch as settled work', () => {
  const shown = { dispatch: { status: 'completed' }, observation: { status: 'live' }, projection: { liveness: { verdict: 'live' } } };
  expect(interpretWorkerShow(shown)).toBe('settled');
});

describe('Orca worker-start receipt', () => {
  it('uses the IDs and terminal effect returned by the installed CLI', () => {
    const receipt = {
      runId: 'run_b76bace6cd54', taskId: 'task_391c31c50c4b', dispatchId: 'ctx_cfc504ed2891',
      effects: [{ kind: 'terminal', role: 'agent', id: 'term_af3d8e8e-0991-411f-a74a-7f95a5ae2f5f' }]
    };
    expect(extractStartedRef(receipt, 'C:/project')).toEqual({
      runId: 'run_b76bace6cd54', taskId: 'task_391c31c50c4b', dispatchId: 'ctx_cfc504ed2891',
      owner: 'lead', repoPath: 'C:/project', terminal: 'term_af3d8e8e-0991-411f-a74a-7f95a5ae2f5f'
    });
  });
});

it('binds to the Goal Run and acknowledges the exact Orca Delivery', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[1] === 'run-use') return { run: { id: 'run_1' } };
    if (args.includes('--ack')) return { acknowledged: 'delivery_1', messages: [] };
    return { deliveryId: 'delivery_1', messages: [{ id: 'msg_1', type: 'status', body: 'ready' }] };
  });
  const delivery = await runtime.checkRun('run_1');
  expect(delivery).toEqual({ deliveryId: 'delivery_1', messages: [{ id: 'msg_1', type: 'status', body: 'ready' }] });
  await runtime.ackRun('run_1', delivery.deliveryId!);
  expect(calls.filter(args => args[1] === 'run-use')).toHaveLength(2);
  expect(calls.at(-1)).toEqual(['orchestration', 'check', '--run', 'run_1', '--ack', 'delivery_1']);
});

it('releases a terminal only after Orca reports a settled Dispatch', async () => {
  const calls: string[][] = [];
  let status = 'dispatched';
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args[1] === 'worker-show') return { dispatch: { status } };
    return { releaseState: 'released' };
  });
  await expect(runtime.releaseWorker('ctx_1')).rejects.toThrow(/settle/);
  expect(calls.some(args => args[1] === 'worker-release')).toBe(false);
  status = 'completed';
  await runtime.releaseWorker('ctx_1');
  expect(calls.at(-1)).toEqual(['orchestration', 'worker-release', '--dispatch', 'ctx_1']);
});

it('treats a resume whose brief sits unsubmitted (pending, turn_start_unobserved, no heartbeat) as stalled input', async () => {
  const shown = (status: string, stage: string, heartbeat?: string) => new OrcaRuntime(() => ({ dispatch: { status, lastHeartbeatAt: heartbeat ?? null }, worker: { stage } }));
  expect(await shown('pending', 'turn_start_unobserved').inputStalled('ctx')).toBe(true);
  expect(await shown('dispatched', 'input_accepted').inputStalled('ctx')).toBe(true);
  expect(await shown('dispatched', 'turn_started', '2026-11-08T00:00:00Z').inputStalled('ctx')).toBe(false);
  expect(await shown('completed', 'settled').inputStalled('ctx')).toBe(false);
});

it('writes a long repair finding to a note file and keeps the pasted brief short (seen live: 7.8k chars never submitted)', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const notes = mkdtempSync(join(tmpdir(), 'apos-notes-'));
  let spec = '';
  const runtime = new OrcaRuntime(args => {
    if (args[1] === 'worker-start') { spec = args[args.indexOf('--spec') + 1]; return { taskId: 't', dispatchId: 'ctx_2', runId: 'r', worker: { worktreeId: 'repo::wt' } }; }
    return {};
  }, undefined, undefined, undefined, () => notes);
  const finding = 'x'.repeat(5000);
  await runtime.resumeSolo({ runId: 'r', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: 'C:/repo', terminal: 'term', worktreeId: 'repo::wt' }, { phase: 'controller finding', progress: finding, evidenceRefs: [], goalId: 'GOAL-X', attempt: 2 }, 'key-1');
  expect(spec.length).toBeLessThan(1500);
  expect(spec).toMatch(/read it in full from .*key-1\.md \(sha256 [0-9a-f]{64}\)/);
  expect(readFileSync(join(notes, 'key-1.md'), 'utf8')).toContain(finding);
  rmSync(notes, { recursive: true, force: true });
});

describe('terminalWorktree', () => {
  it('finds the Lead terminal worktree so a wake never targets the main checkout', () => {
    const seen: string[][] = [];
    const execute = (args: string[]) => { seen.push(args); return { terminal: { worktreeId: 'repo::C:/orca/lead' } }; };
    expect(terminalWorktree('term_1', execute)).toBe('id:repo::C:/orca/lead');
    expect(seen[0]).toEqual(['terminal', 'show', '--terminal', 'term_1']);
    expect(() => terminalWorktree('term_1', () => ({ terminal: {} }))).toThrow(/terminal worktree/);
  });
});

it('composes a package base that contains the repo head and every verified dependency commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-compose-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'wp-a'); writeFileSync(join(dir, 'slugify.js'), 'export const slugify = s => s;\n'); git('add', '.'); git('commit', '-qm', 'wp-a');
    const dep = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    const base = composeBase(dir, head, [dep, dep], 'WP-B');
    expect(base).not.toBe(head);
    expect(git('merge-base', '--is-ancestor', dep, base)).toBe('');
    expect(git('merge-base', '--is-ancestor', head, base)).toBe('');
    expect(git('show', `${base}:slugify.js`)).toContain('slugify');
    expect(composeBase(dir, base, [dep], 'WP-B')).toBe(base);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('reads the Orca 1.4.254 shapes: run-create answers runId, a start receipt names terminal and workspace', async () => {
  const runtime = new OrcaRuntime(args => {
    if (args[0] === 'repo') return { repo: { id: 'repo_1' } };
    if (args[1] === 'run-create') return { runId: 'run_1', objective: 'x' };
    return { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', terminal: 'term_1', workspace: 'wt::C:/w' };
  }, () => 'a'.repeat(40), DEFAULT_PROFILES, () => 'd'.repeat(64));
  const ref = await runtime.startLead({ repoPath: 'C:/project', goalId: 'GOAL-001', goalVersion: 1, idempotencyKey: 'key-1' });
  expect(ref).toMatchObject({ runId: 'run_1', terminal: 'term_1', worktreeId: 'wt::C:/w' });
});

import { idleMinutesFrom } from './orca.js';
it('reads how long Orca says an agent has been idle', () => {
  expect(idleMinutesFrom({ activity: 'idle', lastActivity: '10m ago' })).toBe(10);
  expect(idleMinutesFrom({ activity: 'idle', lastActivity: '1h ago' })).toBe(60);
  expect(idleMinutesFrom({ activity: 'working', lastActivity: '10m ago' })).toBeUndefined();
  expect(idleMinutesFrom({ activity: 'idle', lastActivity: 'just now' })).toBeUndefined();
  expect(idleMinutesFrom({ dispatch: { status: 'dispatched' } })).toBeUndefined();
});

it('asks the concise worker-show for the idle age because the full record has none', async () => {
  const calls: string[][] = [];
  const runtime = new OrcaRuntime(args => {
    calls.push(args);
    if (args.includes('--compact')) return { state: 'ready', liveness: 'live', activity: 'idle', lastActivity: '18m ago' };
    return { dispatch: { status: 'dispatched' }, projection: { liveness: { verdict: 'live' }, stage: { activity: 'done' } } };
  });
  const observed = await runtime.inspect({ runId: 'run_1', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: 'C:/p' });
  expect(observed).toMatchObject({ state: 'live', idleMinutes: 18 });
  const settled = await new OrcaRuntime(args => { calls.push(args); return { dispatch: { status: 'completed' } }; }).inspect({ runId: 'run_1', taskId: 't', dispatchId: 'ctx_2', owner: 'lead', repoPath: 'C:/p' });
  expect(settled.idleMinutes).toBeUndefined();
  expect(calls.filter(args => args.includes('--compact')).map(args => args[3])).toEqual(['ctx_1']);
});

it('recovers a lost Lead dispatch with its terminal, from the Orca 1.4.255 field names', async () => {
  const runtime = new OrcaRuntime(args => {
    if (args[1] === 'run-list') return { runs: [{ id: 'run_lead', objective: 'APOS GOAL-001 lead v1 key key-1' }] };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task_1', spec: `GOAL-001: APOS Lead. APOS repo: <C:/project>. APOS dispatch key: key-1. APOS base commit: ${'a'.repeat(40)}.` }] };
    if (args[1] === 'dispatch-show') return { dispatch: { id: 'ctx_1', assigneeHandle: 'structworker_1' } };
    return { worker: { worktreeId: 'wt::C:/w', agentTerminalHandle: 'structworker_1' } };
  });
  expect(await runtime.recover('key-1')).toMatchObject({ runId: 'run_lead', dispatchId: 'ctx_1', terminal: 'structworker_1', worktreeId: 'wt::C:/w', baseCommit: 'a'.repeat(40) });
});
