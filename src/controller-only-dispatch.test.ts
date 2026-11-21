import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { spec as baseSpec, proposal, sourceText } from './domain/fixtures.test-support.js';
import { OrcaRuntime } from './runtime/orca/adapter.js';
import { OrcaRefused } from './runtime/orca/exec.js';
import { DEFAULT_PROFILES } from './runtime/brief.js';
import { ProjectJournal } from './store/journal.js';
import { controllerHome } from './store/event-log.js';
import type { GoalSpec } from './domain/contracts.js';
import type { WorkPackageSpec } from './domain/packages.js';

// G2: only the controller starts workers and coordinates their Orca Runs. Orca fences `worker-start --run` and
// `check --run` to the Run's coordinator, and `run-use` takes a Run from whoever holds it while unbinding every other
// Run of the caller. These tests drive the real OrcaRuntime against a fake Orca that enforces that fence.

vi.setConfig({ testTimeout: 90_000 });

const spec: GoalSpec = {
  ...baseSpec,
  checks: [
    { id: 'CHK-1', kind: 'command', command: 'node harness.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
  ],
};
const a: WorkPackageSpec = {
  id: 'WP-01',
  goalId: spec.id,
  goalVersion: 1,
  version: 1,
  owner: 'worker-a',
  outcome: 'QR intake',
  scope: ['scanner'],
  exclusions: [],
  dependencies: [],
  interfaces: ['checkIn(token)@v1'],
  acceptance: [{ id: 'WP-AC-1', text: 'scan', goalAcceptanceId: 'AC-1' }],
  integration: 'Lead integrates',
};
const b: WorkPackageSpec = {
  ...a,
  id: 'WP-02',
  owner: 'worker-b',
  outcome: 'History',
  scope: ['history'],
  dependencies: ['WP-01'],
  acceptance: [{ id: 'WP-AC-2', text: 'history works' }],
};
const CONTROLLER = 'term_controller';
const BOT_CHAT = 'chat-of-the-bot';
const FORBIDDEN = ['run-create', 'run-use', 'worker-start'];

const dirs: string[] = [];
afterEach(() => {
  delete process.env.ORCA_TERMINAL_HANDLE;
  delete process.env.ORCA_AGENT_SESSION_ID;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** Orca as far as APOS uses it, with the 1.4.265 Run fence: only the coordinator starts workers or reads mail. */
function fakeOrca(leadTree: string) {
  const calls: { argv: string[]; caller?: string }[] = [];
  const runs = new Map<string, { objective: string; coordinator: string | null; generation: number }>();
  const dispatches = new Map<string, { status: string; terminal: string; runId: string }>();
  const mail = new Map<string, { id: string; type: string; from: string; subject: string; body: string }[]>();
  const replies: { runId: string; id: string; body: string }[] = [];
  let n = 0;
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const fence = (runId: string) => {
    const run = runs.get(runId);
    if (!run) throw new OrcaRefused(`Run ${runId} not found`, 'run_not_found');
    if (run.coordinator !== process.env.ORCA_TERMINAL_HANDLE)
      throw new OrcaRefused(`This caller does not coordinate Run ${runId}`, 'consumer_fenced');
  };
  const execute = (args: string[]): Record<string, unknown> => {
    calls.push({ argv: args, caller: process.env.ORCA_TERMINAL_HANDLE });
    const verb = `${args[0]} ${args[1]}`;
    switch (verb) {
      case 'repo add':
        return { repo: {} };
      case 'orchestration run-list':
        return { runs: [...runs].map(([id, run]) => ({ id, objective: run.objective })), nextCursor: null };
      case 'orchestration run-create': {
        const id = `run_${++n}`;
        runs.set(id, {
          objective: flag(args, '--objective'),
          coordinator: process.env.ORCA_TERMINAL_HANDLE ?? null,
          generation: 1,
        });
        return { runId: id };
      }
      case 'orchestration run-use': {
        const run = runs.get(flag(args, '--id'))!;
        run.coordinator = process.env.ORCA_TERMINAL_HANDLE ?? null;
        run.generation += 1;
        return { run: { id: flag(args, '--id') } };
      }
      case 'orchestration run-show': {
        const run = runs.get(flag(args, '--id'))!;
        return {
          run: { id: flag(args, '--id'), coordinator_handle: run.coordinator, consumer_generation: run.generation },
        };
      }
      case 'orchestration worker-start': {
        const runId = flag(args, '--run');
        fence(runId);
        const dispatchId = `ctx_${++n}`;
        const lead = flag(args, '--name')?.includes('-lead-');
        const terminal = args.includes('--terminal') ? flag(args, '--terminal') : `term_${dispatchId}`;
        dispatches.set(dispatchId, { status: 'dispatched', terminal, runId });
        return {
          runId,
          taskId: `task_${n}`,
          dispatchId,
          terminal,
          workspace: lead ? `repo::${leadTree}` : `repo::${leadTree}-${dispatchId}`,
        };
      }
      case 'orchestration worker-show': {
        const item = dispatches.get(flag(args, '--dispatch'));
        return {
          dispatch: { status: item?.status ?? 'failed' },
          projection: { liveness: { verdict: 'live' } },
          worker: { stage: 'ready' },
          terminalResource: { releaseState: 'retained' },
        };
      }
      case 'orchestration worker-stop': {
        const item = dispatches.get(flag(args, '--dispatch'));
        if (item) item.status = 'failed';
        return { state: 'stopped', processAction: 'closed_agent_terminal' };
      }
      case 'orchestration check': {
        const runId = flag(args, '--run');
        fence(runId);
        const rows = mail.get(runId) ?? [];
        if (!args.includes('--peek')) mail.set(runId, []);
        return { messages: rows };
      }
      case 'orchestration reply': {
        fence(flag(args, '--run'));
        replies.push({ runId: flag(args, '--run'), id: flag(args, '--id'), body: flag(args, '--body') });
        return { ok: true };
      }
      case 'bot chats':
        if (process.env.ORCA_AGENT_SESSION_ID !== BOT_CHAT) throw new OrcaRefused('not a bot chat', 'invalid_argument');
        return { bot: 'Lead APOS' };
      case 'bot list':
        return { bots: [{ id: 'bot-lead-apos', name: 'Lead APOS' }] };
      case 'orchestration send':
        return { messageId: `msg_${++n}` };
      case 'terminal read':
        return { terminal: { tail: [] } };
      default:
        return {};
    }
  };
  return { execute, calls, runs, dispatches, mail, replies };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-g2-'));
  const leadTree = mkdtempSync(join(tmpdir(), 'apos-g2-lead-'));
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-g2-art-'));
  dirs.push(dir, leadTree, artifacts);
  execFileSync('git', ['init', '-q', dir]);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const commit = (file: string, content: string, message: string) => {
    writeFileSync(join(dir, file), content);
    git('add', file);
    git('-c', 'user.name=Worker', '-c', 'user.email=w@local.invalid', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const input = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.json\nbrief.md\n*.txt\n');
  writeFileSync(join(dir, 'brief.md'), sourceText);
  commit('harness.js', "require('./feature.js');", 'harness');
  const orca = fakeOrca(leadTree);
  const runtime = new OrcaRuntime(
    orca.execute,
    path => execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    DEFAULT_PROFILES,
    () => 'd'.repeat(64),
  );
  const output: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { runtime, gate: { artifactRoot: artifacts }, write: line => output.push(line) });
  /** Runs `fn` as `who` and returns the Orca verbs it called, after checking it called none that start or bind. */
  const as = async (who: { terminal?: string; session?: string }, fn: () => Promise<unknown>) => {
    const from = orca.calls.length;
    if (who.terminal) process.env.ORCA_TERMINAL_HANDLE = who.terminal;
    else delete process.env.ORCA_TERMINAL_HANDLE;
    if (who.session) process.env.ORCA_AGENT_SESSION_ID = who.session;
    else delete process.env.ORCA_AGENT_SESSION_ID;
    try {
      await fn();
    } finally {
      delete process.env.ORCA_TERMINAL_HANDLE;
      delete process.env.ORCA_AGENT_SESSION_ID;
    }
    return orca.calls.slice(from).map(call => call.argv);
  };
  const tick = () => as({ terminal: CONTROLLER }, () => invoke('controller', 'tick'));
  const journal = () => {
    const opened = ProjectJournal.open(dir);
    try {
      return { goal: opened.journal.getGoal(spec.id)!, events: opened.journal.events(spec.id) };
    } finally {
      opened.close();
    }
  };
  return { dir, leadTree, orca, invoke, as, tick, journal, commit, input, output };
}

const verbs = (argvs: string[][]) => argvs.map(argv => argv[1]);
const startsOrBinds = (argvs: string[][]) =>
  argvs.filter(argv => argv[0] === 'orchestration' && FORBIDDEN.includes(argv[1]));

describe('only the controller starts workers and coordinates their Runs (G2)', () => {
  it('turns every dispatching command into a request, and the next tick starts it with --run, never run-use', async () => {
    const t = await setup();
    const human = { terminal: 'term_human' };
    const generations = () => [...t.orca.runs.values()].map(run => run.generation);

    // Gate B from the Human's own terminal: the Lead is requested, not started.
    expect(
      startsOrBinds(
        await t.as(human, async () => {
          await t.invoke('init');
          await t.invoke('goal', 'create', '--file', t.input('goal.json', spec), '--source', join(t.dir, 'brief.md'));
          await t.invoke(
            'goal',
            'approve',
            spec.id,
            '--size',
            'M',
            '--max-spend',
            '20',
            '--max-minutes',
            '240',
            '--max-attempts',
            '3',
          );
          await t.invoke('goal', 'select', spec.id);
          await t.invoke('lead', 'start', spec.id); // a second request is the same request
        }),
      ),
    ).toEqual([]);
    expect(t.journal().goal.requests).toHaveLength(1);
    const first = await t.tick();
    const startLead = first.find(argv => argv[1] === 'worker-start')!;
    expect(startLead).toEqual(expect.arrayContaining(['--run', 'run_1']));
    expect(t.orca.runs.get('run_1')).toMatchObject({ coordinator: CONTROLLER, generation: 1 });
    const leadTerminal = t.journal().goal.lead!.ref.terminal;

    // The APOS Lead (a worker terminal) plans and commits: the controller dispatches the ready package.
    expect(
      startsOrBinds(
        await t.as({ terminal: leadTerminal }, async () => {
          await t.invoke('lead', 'propose', '--file', t.input('proposal.json', { ...proposal, mode: 'multi-wp' }));
          await t.invoke('package', 'add', '--file', t.input('wp-a.json', a), '--reason', 'First stage');
          await t.invoke('package', 'add', '--file', t.input('wp-b.json', b), '--reason', 'Second stage');
          await t.invoke('lead', 'commit', spec.id);
        }),
      ),
    ).toEqual([]);
    const second = await t.tick();
    expect(startsOrBinds(second).map(argv => argv[1])).toEqual(['run-create', 'worker-start']);
    const packageRun = t.journal().goal.packages!['WP-01'].runtimeRef!.runId;
    expect(t.orca.runs.get(packageRun)).toMatchObject({ coordinator: CONTROLLER, generation: 1 });

    // The Human moves the Lead to a bot: requested, then carried out by the controller.
    expect(
      startsOrBinds(await t.as(human, () => t.invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh'))),
    ).toEqual([]);
    await t.tick();
    expect(t.journal().goal.leadBot).toMatchObject({ id: 'bot-lead-apos' });

    // The bot verifies WP-01, releases WP-02 and answers a Worker's question from its own chat.
    const commitA = t.commit('feature.js', 'process.exit(0);', 'scanner');
    t.orca.dispatches.get(t.journal().goal.packages!['WP-01'].runtimeRef!.dispatchId)!.status = 'completed';
    t.orca.mail.set(packageRun, [
      {
        id: 'msg_q1',
        type: 'question',
        from: t.journal().goal.packages!['WP-01'].runtimeRef!.terminal!,
        subject: 'token format',
        body: 'JWT or opaque?',
      },
    ]);
    const asked = await t.tick();
    expect(startsOrBinds(asked)).toEqual([]);
    expect(
      t
        .journal()
        .events.filter(item => item.type === 'lead-woken')
        .at(-1)?.data,
    ).toMatchObject({
      events: expect.arrayContaining([
        expect.stringContaining('question question msg_q1 from the Worker of WP-01 (token format: JWT or opaque?)'),
      ]),
    });
    const bot = { session: BOT_CHAT };
    const botCalls = await t.as(bot, async () => {
      await t.invoke(
        'package',
        'evidence',
        spec.id,
        '--file',
        t.input('ev-a.json', {
          packageId: 'WP-01',
          packageVersion: 1,
          owner: 'worker-a',
          acceptanceId: 'WP-AC-1',
          result: 'pass',
          command: 'npm test',
          artifactRef: 'log:WP-01',
          commitRef: commitA,
        }),
      );
      await t.invoke('package', 'verify', spec.id, 'WP-01');
      await t.invoke('package', 'approve', spec.id, 'WP-02', '--reason', 'WP-01 checked');
      await t.invoke('package', 'dispatch', spec.id);
      await t.invoke(
        'package',
        'answer',
        spec.id,
        'WP-01',
        '--message-id',
        'msg_q1',
        '--text-file',
        t.input('answer.txt', 'Opaque, see the Goal.'),
        '--reason',
        'Goal says opaque',
      );
      // The bot cannot be the controller either.
      await expect(t.invoke('controller', 'tick')).rejects.toThrow(/cannot run as an agent \(bot Lead APOS\)/);
    });
    expect(startsOrBinds(botCalls)).toEqual([]);
    expect(verbs(botCalls)).not.toContain('reply');
    expect(t.orca.replies).toEqual([]);

    const generationsBefore = generations();
    const third = await t.tick();
    expect(startsOrBinds(third).map(argv => [argv[1], argv[argv.indexOf('--run') + 1]])).toEqual([
      ['worker-start', packageRun],
    ]);
    expect(t.orca.replies).toEqual([{ runId: packageRun, id: 'msg_q1', body: 'Opaque, see the Goal.' }]);
    expect(t.journal().goal.packages!['WP-02'].status).toBe('executing');
    expect(t.journal().goal.requests).toBeUndefined();
    await t.tick();
    // The answered question is handled: the Run's mail is consumed and the Lead is not asked again.
    expect(t.orca.mail.get(packageRun)).toEqual([]);

    // Not once did anyone take a Run over, and the controller still coordinates every Run with the same generation.
    expect(t.orca.calls.some(call => call.argv[1] === 'run-use')).toBe(false);
    expect(
      t.orca.calls.filter(call => FORBIDDEN.includes(call.argv[1])).every(call => call.caller === CONTROLLER),
    ).toBe(true);
    expect([...t.orca.runs.values()].every(run => run.coordinator === CONTROLLER)).toBe(true);
    expect(generations()).toEqual(generationsBefore);
  });

  it('starts or binds nothing from any Human command that used to dispatch, whether it is accepted or refused', async () => {
    const t = await setup();
    const human = { terminal: 'term_human' };
    await t.as(human, async () => {
      await t.invoke('init');
      await t.invoke('goal', 'create', '--file', t.input('goal.json', spec), '--source', join(t.dir, 'brief.md'));
      await t.invoke(
        'goal',
        'approve',
        spec.id,
        '--size',
        'M',
        '--max-spend',
        '20',
        '--max-minutes',
        '240',
        '--max-attempts',
        '3',
      );
      await t.invoke('goal', 'select', spec.id);
    });
    await t.tick();
    const leadTerminal = t.journal().goal.lead!.ref.terminal;
    await t.as({ terminal: leadTerminal }, async () => {
      await t.invoke('lead', 'propose', '--file', t.input('proposal.json', { ...proposal, mode: 'multi-wp' }));
      await t.invoke('package', 'add', '--file', t.input('wp-a.json', a), '--reason', 'First stage');
      await t.invoke('package', 'add', '--file', t.input('wp-b.json', b), '--reason', 'Second stage');
      await t.invoke('lead', 'commit', spec.id);
    });
    await t.tick();
    const commands: string[][] = [
      ['lead', 'start', spec.id],
      ['lead', 'wake', spec.id, '--note', 'go on'],
      ['handoff', spec.id],
      ['handoff', spec.id, '--package', 'WP-01', '--agent', 'claude'],
      ['handoff', spec.id, '--reviewer'],
      ['handoff', spec.id, '--to-apos', '--by', 'anh'],
      ['package', 'dispatch', spec.id],
      ['package', 'resume', spec.id, 'WP-01'],
      ['package', 'reconcile', spec.id],
      ['execution', 'start', spec.id],
      ['execution', 'resume', spec.id],
      ['execution', 'retry', spec.id, '--reason', 'again'],
      ['execution', 'reconcile', spec.id],
    ];
    for (const command of commands) {
      const called = await t.as(human, () => t.invoke(...command).catch(() => undefined));
      expect(startsOrBinds(called), command.join(' ')).toEqual([]);
    }
    expect(t.orca.calls.some(call => call.argv[1] === 'run-use')).toBe(false);
  });

  it('leaves a Goal whose Run another terminal holds alone and tells the Human once, instead of taking it back', async () => {
    const t = await setup();
    await t.as({ terminal: 'term_human' }, async () => {
      await t.invoke('init');
      await t.invoke('goal', 'create', '--file', t.input('goal.json', spec), '--source', join(t.dir, 'brief.md'));
      await t.invoke(
        'goal',
        'approve',
        spec.id,
        '--size',
        'M',
        '--max-spend',
        '20',
        '--max-minutes',
        '240',
        '--max-attempts',
        '3',
      );
      await t.invoke('goal', 'select', spec.id);
    });
    await t.tick();
    t.orca.runs.get('run_1')!.coordinator = 'term_bot_chat'; // e.g. an agent ran run-use
    await t.as({ terminal: 'term_human' }, () => t.invoke('lead', 'wake', spec.id, '--note', 'go on'));
    const drifted = await t.tick();
    const again = await t.tick();
    expect(startsOrBinds([...drifted, ...again])).toEqual([]);
    expect(verbs([...drifted, ...again])).not.toContain('check');
    const notices = t
      .journal()
      .events.filter(
        item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'run-coordinator-drift',
      );
    expect(notices).toHaveLength(1);
    expect(notices[0].data).toMatchObject({ runId: 'run_1', holder: 'term_bot_chat', controller: CONTROLLER });
    expect((notices[0].data as { note: string }).note).toMatch(/does not take the Run back/);
    expect(t.journal().goal.requests).toHaveLength(1); // the wake waits for the Run, it does not fail
    expect(t.orca.runs.get('run_1')).toMatchObject({ coordinator: 'term_bot_chat', generation: 1 });
  });

  it('refuses to run the controller in an agent session or an APOS agent terminal', async () => {
    const t = await setup();
    await t.as({ terminal: 'term_human' }, async () => {
      await t.invoke('init');
      await t.invoke('goal', 'create', '--file', t.input('goal.json', spec), '--source', join(t.dir, 'brief.md'));
      await t.invoke(
        'goal',
        'approve',
        spec.id,
        '--size',
        'M',
        '--max-spend',
        '20',
        '--max-minutes',
        '240',
        '--max-attempts',
        '3',
      );
      await t.invoke('goal', 'select', spec.id);
    });
    await t.tick();
    const leadTerminal = t.journal().goal.lead!.ref.terminal;
    const refused = await t.as({ terminal: leadTerminal }, () =>
      expect(t.invoke('controller', 'tick')).rejects.toThrow(/cannot run as an agent \(APOS agent terminal/),
    );
    const worker = await t.as({ terminal: 'structworker_x', session: 'worker-session' }, () =>
      expect(t.invoke('controller', 'tick')).rejects.toThrow(
        /cannot run as an agent \(Orca agent session worker-session\)/,
      ),
    );
    expect(startsOrBinds([...refused, ...worker])).toEqual([]);
    // A live watch in another terminal coordinates this project's Runs: a tick from here would create Runs it cannot read.
    const home = controllerHome(t.dir);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'controller.heartbeat'),
      JSON.stringify({ pid: process.ppid, at: new Date().toISOString(), terminal: 'term_watch' }),
    );
    const beside = await t.as({ terminal: 'term_elsewhere' }, () =>
      expect(t.invoke('controller', 'tick')).rejects.toThrow(
        /a controller watch \(pid \d+\) runs in Orca terminal term_watch/,
      ),
    );
    expect(beside).toEqual([]);
  });
});

it('keeps run-use out of the Orca adapter', () => {
  const root = fileURLToPath(new URL('./runtime', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? files(path)
        : path.endsWith('.ts') && !path.endsWith('.test.ts')
          ? [path]
          : [];
    });
  const offenders = files(root).filter(path => /'run-use'/.test(readFileSync(path, 'utf8')));
  expect(offenders).toEqual([]);
});
