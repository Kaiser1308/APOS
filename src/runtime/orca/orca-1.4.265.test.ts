import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { OrcaRuntime } from './adapter.js';
import { COMPACT, orcaArgs } from './exec.js';
import { assigneeOf, extractStartedRef, idleMinutesFrom, interpretWorkerShow, messagesOf, object } from './parse.js';

// Real `--json` output of Orca 1.4.265, captured in a scratch repo on 2026-11-21 (paths shortened). The package
// Run comes from the G1 smoke: a real package start whose response was dropped, then `reconcile`.
const fixture = (name: string): Record<string, unknown> =>
  object(
    JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/orca-1.4.265/${name}.json`, import.meta.url)), 'utf8'))
      .result,
  );

const KEY = '096f4fc3-f02d-486a-8a49-15654acffe0a';
const RUN = 'run_ce076e854991';
const REPO = 'C:/scratch/smoke-repo';
const WORKTREE = '34f05e12-c15c-4248-a36d-98d2d6e7f528::C:/orca/workspaces/smoke-repo/apos-goal-001-wp-01-096f4fc3';

/** Answers like Orca 1.4.265 for the argv `runOrca` would send: concise unless that argv asks for `--full`. */
function orca1_4_265(calls: string[][] = []) {
  return (args: string[]): Record<string, unknown> => {
    calls.push(args);
    const full = orcaArgs(args).includes('--full');
    const verb = `${args[0]} ${args[1]}`;
    if (verb === 'orchestration run-list') return fixture('run-list');
    if (verb === 'orchestration task-list') return fixture(full ? 'task-list-full' : 'task-list');
    if (verb === 'orchestration dispatch-show') return fixture('dispatch-show');
    if (verb === 'orchestration worker-show') return fixture(full ? 'worker-show-full' : 'worker-show');
    if (verb === 'orchestration run-use') return { runId: RUN };
    throw new Error(`unexpected orca call ${args.join(' ')}`);
  };
}

describe('Orca 1.4.265 recovery after a lost start response', () => {
  it('asks task-list for the full record, the only view that carries the spec and its dispatch key', () => {
    expect(orcaArgs(['orchestration', 'task-list', '--run', RUN])).toEqual([
      'orchestration',
      'task-list',
      '--run',
      RUN,
      '--full',
      '--json',
    ]);
    expect(fixture('task-list').tasks).toEqual([expect.not.objectContaining({ spec: expect.anything() })]);
    expect(String(object((fixture('task-list-full').tasks as unknown[])[0]).spec)).toContain(
      `APOS dispatch key: ${KEY}.`,
    );
  });

  it('recoverPackage finds the dispatch that did start, by its key', async () => {
    const calls: string[][] = [];
    const runtime = new OrcaRuntime(orca1_4_265(calls));
    expect(await runtime.recoverPackage(KEY, RUN)).toEqual({
      runId: RUN,
      taskId: 'task_66090d36090e',
      dispatchId: 'ctx_4198479649aa',
      owner: 'worker',
      repoPath: REPO,
      terminal: 'structworker_0dd0f5af-1555-4a37-8c3a-46d12a5be5f6',
      worktreeId: WORKTREE,
      baseCommit: '768fedcc9d9b1d9bfc850b65168a8334c6734159',
    });
    expect(calls.some(args => args[1] === 'worker-start')).toBe(false);
  });

  it('recover finds it too, also when it has to look the Run up by objective', async () => {
    const runtime = new OrcaRuntime(orca1_4_265());
    expect(await runtime.recover(KEY, RUN)).toMatchObject({ dispatchId: 'ctx_4198479649aa', worktreeId: WORKTREE });
    expect(await runtime.recoverPackage(KEY)).toMatchObject({ dispatchId: 'ctx_4198479649aa' });
  });

  it('finds nothing for another key, so the caller keeps the intent instead of guessing', async () => {
    const runtime = new OrcaRuntime(orca1_4_265());
    expect(await runtime.recover('another-key', RUN)).toBeUndefined();
  });
});

describe('Orca 1.4.265 records the adapter reads', () => {
  it('reads the concise worker-start receipt: terminal and workspace stand in for the effects', () => {
    expect(orcaArgs(['orchestration', 'worker-start', '--spec', 'x'])).not.toContain('--full');
    expect(extractStartedRef(fixture('worker-start'), REPO)).toEqual({
      runId: 'run_21c066a74d51',
      taskId: 'task_fd02df278a39',
      dispatchId: 'ctx_1c2a1160ebff',
      owner: 'lead',
      repoPath: REPO,
      terminal: 'structworker_1456086d-52dd-4bd5-a607-d776b602d679',
      worktreeId: '34f05e12-c15c-4248-a36d-98d2d6e7f528::C:/orca/workspaces/smoke-repo/g1-probe2',
    });
  });

  it('reads worker-show full and concise', () => {
    const full = fixture('worker-show-full');
    expect(interpretWorkerShow(full)).toBe('live');
    expect(object(full.worker).worktreeId).toBe(WORKTREE);
    expect(assigneeOf(object(fixture('dispatch-show').dispatch), object(full.worker))).toBe(
      'structworker_0dd0f5af-1555-4a37-8c3a-46d12a5be5f6',
    );
    expect(orcaArgs(['orchestration', 'worker-show', '--dispatch', 'ctx_1', COMPACT])).not.toContain('--full');
    expect(idleMinutesFrom(fixture('worker-show'))).toBeUndefined(); // working, not idle
  });

  it('reads check rows, which carry no Delivery id', () => {
    expect(fixture('check-peek').deliveryId).toBeUndefined();
    expect(messagesOf(fixture('check-peek')).map(item => item.type)).toEqual(['question', 'status', 'worker_done']);
    expect(messagesOf(fixture('check-consume-empty'))).toEqual([]);
  });
});

describe('Orca 1.4.265 mail: a consuming check marks its batch handled', () => {
  it('checkRun peeks, so mail the controller leaves pending is still unread next tick', async () => {
    const calls: string[][] = [];
    const runtime = new OrcaRuntime(args => {
      calls.push(args);
      return args[1] === 'check' ? fixture('check-peek') : {};
    });
    const delivery = await runtime.checkRun('run_21c066a74d51');
    expect(delivery.messages.map(item => item.id)).toEqual([
      'msg_54e54fbdf34c',
      'msg_f99a4f63806b',
      'msg_18d9c9b6ab36',
    ]);
    expect(calls.at(-1)).toEqual(['orchestration', 'check', '--run', 'run_21c066a74d51', '--peek']);
  });

  it('ackRun consumes without --ack and returns only the mail that arrived after the read', async () => {
    const calls: string[][] = [];
    const runtime = new OrcaRuntime(args => {
      calls.push(args);
      return args[1] === 'check' ? fixture('check-consume') : {};
    });
    const late = await runtime.ackRun('run_21c066a74d51', ['msg_54e54fbdf34c', 'msg_f99a4f63806b']);
    expect(late.map(item => item.id)).toEqual(['msg_18d9c9b6ab36']);
    expect(calls.at(-1)).toEqual(['orchestration', 'check', '--run', 'run_21c066a74d51']);
  });

  it('an already-empty batch is a no-op, not an error', async () => {
    const runtime = new OrcaRuntime(args => (args[1] === 'check' ? fixture('check-consume-empty') : {}));
    await expect(runtime.ackRun('run_21c066a74d51', ['msg_gone'])).resolves.toEqual([]);
  });
});

describe('Orca 1.4.265 terminal and keep-open', () => {
  it('reads the rendered screen, and still gets lines where Orca has no screen (a chat worker)', async () => {
    const calls: string[][] = [];
    const runtime = new OrcaRuntime(args => {
      calls.push(args);
      return fixture(
        args[3] === 'term_295f92d8-b942-4781-833c-646fe4e47978'
          ? 'terminal-read-screen'
          : 'terminal-read-screen-unavailable',
      );
    });
    expect(await runtime.composerPending('term_295f92d8-b942-4781-833c-646fe4e47978', 'codex')).toBe(false);
    expect(await runtime.agentQuota('structworker_31e61bf0-470b-44ae-92a3-33400ff4e299', 'claude')).toBeUndefined();
    expect(calls.every(args => args[0] === 'terminal' && args[1] === 'read' && args.includes('--screen'))).toBe(true);
  });

  it('keeps a settled worker open with worker-keep-open, and skips one Orca already reports retained', async () => {
    const calls: string[][] = [];
    const settled = (releaseState: string) => (args: string[]) => {
      calls.push(args);
      if (args[1] === 'worker-show')
        return {
          ...fixture('worker-show-full'),
          dispatch: { status: 'completed' },
          terminalResource: { releaseState },
        };
      return fixture('worker-keep-open');
    };
    await new OrcaRuntime(settled('retained')).retainWorker('ctx_1');
    expect(calls.map(args => args[1])).toEqual(['worker-show']);
    await new OrcaRuntime(settled('active')).retainWorker('ctx_1');
    expect(calls.at(-1)).toEqual(['orchestration', 'worker-keep-open', '--dispatch', 'ctx_1']);
  });
});

describe('runOrca on a worker-start whose turn Orca has not observed yet', () => {
  it('returns the receipt instead of throwing, because the worker did start', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: () => {
        throw Object.assign(new Error('exit 1'), {
          stdout: JSON.stringify({
            ok: true,
            result: { ...fixture('worker-start'), state: 'started', stage: 'turn_start_unobserved' },
          }),
        });
      },
    }));
    const { runOrca } = await import('./exec.js');
    expect(runOrca(['orchestration', 'worker-start', '--spec', 'x'])).toMatchObject({
      dispatchId: 'ctx_1c2a1160ebff',
      stage: 'turn_start_unobserved',
    });
    expect(() => runOrca(['orchestration', 'run-create', '--objective', 'x'])).toThrow(/run-create/);
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });
});
