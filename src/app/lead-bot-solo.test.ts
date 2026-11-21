import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { spec as baseSpec, proposal, sourceText } from '../domain/fixtures.test-support.js';
import { CORE_SKILL, activationLine, committedFileDigest, soloReportPath } from '../runtime/brief.js';
import { ProjectJournal } from '../store/journal.js';
import { SqliteStore } from '../store/sqlite.js';
import { SoloService } from './solo.js';
import { UserError } from '../domain/errors.js';
import { approval } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { GoalSpec } from '../domain/contracts.js';
import type { BotIdentity, BotWakeInput, HandoffInput, RuntimeAdapter } from '../ports/runtime.js';
import type { RuntimeRef } from '../domain/runtime-refs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const spec: GoalSpec = {
  ...baseSpec,
  checks: [
    { id: 'CHK-1', kind: 'command', command: 'node harness.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
  ],
};
const BOT: BotIdentity = { id: 'bot-lead-apos', name: 'Lead APOS' };

/**
 * A fake Orca: the APOS Lead plans in its own worktree, the Human moves its role to a bot, and the bot (a chat that
 * Orca names through `callerBot`) proposes and commits. The Solo owner the controller then starts on that worktree is
 * the only one that commits code; gate, findings, resume and verification are the real controller on real Git.
 */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-bot-solo-'));
  dirs.push(dir);
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-bot-solo-art-'));
  dirs.push(artifacts);
  execFileSync('git', ['init', '-q', dir]);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'harness.js'), "require('./feature.js');");
  git('add', 'harness.js');
  git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'harness');
  let base = '';
  let tree = '';
  const settled = new Set<string>();
  const dispatches: string[] = [];
  const handoffs: HandoffInput[] = [];
  const mails: BotWakeInput[] = [];
  const stopped: string[] = [];
  let caller: BotIdentity | undefined;
  let attempt = 0;
  const ref = (dispatchId: string): RuntimeRef => ({
    runId: 'run_1',
    taskId: `task_${dispatchId}`,
    dispatchId,
    owner: 'lead',
    repoPath: dir,
    terminal: `term_${dispatchId}`,
    worktreeId: `repo::${tree}`,
    baseCommit: base,
  });
  const deliver = (dispatchId: string) => {
    attempt += 1;
    const line = activationLine(committedFileDigest(dir, base, CORE_SKILL));
    const files = {
      'feature.js': attempt === 1 ? 'process.exit(1);' : 'process.exit(0);',
      [soloReportPath(spec.id, attempt)]: `# Delivery\n\n${line}\nreviewedHead: HEAD\n`,
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(tree, name, '..'), { recursive: true });
      writeFileSync(join(tree, name), content);
    }
    execFileSync('git', ['-C', tree, 'add', '--', ...Object.keys(files)]);
    execFileSync('git', [
      '-C',
      tree,
      '-c',
      'user.name=Owner',
      '-c',
      'user.email=o@local.invalid',
      'commit',
      '-qm',
      `owner ${attempt}`,
    ]);
    settled.add(dispatchId);
  };
  const runtime: RuntimeAdapter = {
    async startLead() {
      base = git('rev-parse', 'HEAD');
      tree = join(mkdtempSync(join(tmpdir(), 'apos-bot-solo-wt-')), 'wt');
      dirs.push(join(tree, '..'));
      git('worktree', 'add', '-q', '-b', 'lead', tree, base);
      dispatches.push('lead');
      return ref('ctx_lead');
    },
    async handoff(input) {
      handoffs.push(input);
      dispatches.push('owner');
      deliver('ctx_owner');
      return ref('ctx_owner');
    },
    async resumeSolo(prior) {
      dispatches.push(`resume:${prior.dispatchId}`);
      deliver('ctx_owner2');
      return ref('ctx_owner2');
    },
    async inspect(r) {
      return settled.has(r.dispatchId) ? { state: 'settled', outcome: 'completed', ref: r } : { state: 'live', ref: r };
    },
    async stopWorker(dispatchId) {
      stopped.push(dispatchId);
      return 'stopped';
    },
    async deliveryHead(r) {
      return execFileSync('git', ['-C', r.worktreeId!.split('::')[1], 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
    },
    findBot: nameOrId => ([BOT.id, BOT.name].includes(nameOrId) ? BOT : undefined),
    callerBot: () => caller,
    async wakeBot(input) {
      mails.push(input);
      return { messageId: `msg_${mails.length}` };
    },
  };
  const output: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { runtime, gate: { artifactRoot: artifacts }, write: line => output.push(line) });
  const asBot = async <T>(fn: () => Promise<T>): Promise<T> => {
    caller = BOT;
    try {
      return await fn();
    } finally {
      caller = undefined;
    }
  };
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ ...proposal, risks: [] }));
  writeFileSync(join(dir, '.git', 'info', 'exclude'), 'goal.json\nbrief.md\nplan.json\n');
  await invoke('init');
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  await invoke(
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
  await invoke('goal', 'select', spec.id);
  await invoke('controller', 'tick'); // the controller alone dispatches the Lead
  const state = () => {
    const opened = ProjectJournal.open(dir);
    try {
      return { goal: opened.journal.getGoal(spec.id)!, events: opened.journal.events(spec.id) };
    } finally {
      opened.close();
    }
  };
  return { dir, git, invoke, asBot, state, dispatches, handoffs, mails, stopped, output };
}

describe('a bot Lead on a Solo Goal never writes code', () => {
  it('plans as the bot, gets a controller-dispatched owner, and the red gate resumes that same owner', async () => {
    const { invoke, asBot, state, dispatches, handoffs, mails, stopped, dir, output } = await setup();
    // The bot cannot plan before the Human moves the Lead to it.
    await expect(asBot(() => invoke('lead', 'propose', '--file', join(dir, 'plan.json')))).rejects.toThrow(
      /Lead terminal APOS dispatched/,
    );
    await invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh');
    expect(stopped).toEqual([]); // queued: the controller moves the Lead at its next tick
    await invoke('controller', 'tick');
    expect(stopped).toEqual(['ctx_lead']);
    expect(output.at(-1)).toMatch(/moved to bot Lead APOS/);
    expect(state().goal.leadBot).toMatchObject({ id: BOT.id, name: 'Lead APOS', by: 'anh' });
    expect(mails[0]).toMatchObject({ bot: { id: BOT.id }, mode: 'plan', goalId: spec.id });
    expect(mails[0].events[0]).toMatch(/Lead role of GOAL-001 moved to you \(bot Lead APOS\) by anh/);
    // The stopped Lead's terminal no longer speaks for the Lead.
    process.env.ORCA_TERMINAL_HANDLE = 'term_ctx_lead';
    try {
      await expect(invoke('lead', 'propose', '--file', join(dir, 'plan.json'))).rejects.toThrow(/is bot Lead APOS/);
    } finally {
      delete process.env.ORCA_TERMINAL_HANDLE;
    }
    await asBot(async () => {
      await invoke('lead', 'propose', '--file', join(dir, 'plan.json'));
      await invoke('lead', 'commit', spec.id);
    });
    expect(output.join('\n')).toMatch(/the controller dispatches a Solo owner to deliver it at its next tick/);
    expect(handoffs).toHaveLength(0);
    await invoke('controller', 'tick');
    expect(output.at(-1)).toContain('ctx_owner');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ kind: 'solo-owner', attempt: 1 });
    expect(handoffs[0].extra).toMatch(/Lead is the Orca bot Lead APOS/);
    // The Lead worktree predates the plan: the owner gets the accepted plan in its brief.
    expect(handoffs[0].extra).toContain('"approach":"reuse API"');
    expect(handoffs[0].extra).toContain('"verificationStrategy":"integration test"');
    expect(state().goal).toMatchObject({ status: 'executing', runtimeRef: { dispatchId: 'ctx_owner' } });
    await invoke('controller', 'tick');
    await invoke('controller', 'tick');
    expect(dispatches).toEqual(['lead', 'owner', 'resume:ctx_owner']);
    await invoke('controller', 'tick');
    const { goal, events } = state();
    expect(goal).toMatchObject({ status: 'verified', soloAttempts: 2 });
    // Every code commit came from the owner; the bot only issued APOS commands.
    expect(events.filter(item => item.type === 'proposal-drafted' || item.type === 'proposal-approved')).toHaveLength(
      2,
    );
    const told = mails.flatMap(item => item.events);
    expect(told.some(item => /Solo owner finding \(attempt 1, patch\): Controller gate red/.test(item))).toBe(true);
    expect(told.some(item => /is verified on/.test(item))).toBe(true);
    expect(mails.slice(1).every(item => item.mode === 'solo')).toBe(true);
    expect(
      events.filter(item => item.type === 'lead-woken' && (item.data as { bot?: string }).bot === BOT.id).length,
    ).toBe(mails.length);
  }, 90_000);
});

describe('the Solo owner of a bot Lead, when it cannot be started', () => {
  it('reports a runtime with no handoff as a UserError, before recording any dispatch intent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-bot-solo-err-'));
    dirs.push(dir);
    const store = SqliteStore.open(join(dir, 'state.sqlite'));
    try {
      let n = 0;
      const add = (type: GoalEventType, data?: unknown) =>
        store.append({ id: `BS-${++n}`, goalId: spec.id, type, data, at: '2026-11-20T00:00:00.000Z' });
      add('goal-drafted', spec);
      add('goal-approved', approval);
      add('goal-selected');
      add('lead-dispatch-intended', 'lk');
      add('lead-started', {
        runId: 'run_1',
        taskId: 't',
        dispatchId: 'ctx_lead',
        repoPath: dir,
        terminal: 'term_lead',
        worktreeId: `repo::${dir}`,
        baseCommit: 'b'.repeat(40),
      });
      add('handoff-intended', {
        key: 'k',
        target: { kind: 'bot', botId: BOT.id, botName: BOT.name },
        from: 'ctx_lead',
      });
      add('lead-transferred', { key: 'k', from: 'ctx_lead', by: 'anh', bot: BOT });
      add('proposal-drafted', proposal);
      add('proposal-approved');
      const runtime: RuntimeAdapter = {
        startLead: () => Promise.reject(new Error('unused')),
        resumeSolo: () => Promise.reject(new Error('unused')),
        inspect: ref => Promise.resolve({ state: 'live', ref }),
      };
      await expect(new SoloService(store, runtime).adopt(spec.id)).rejects.toBeInstanceOf(UserError);
      expect(store.events(spec.id).some(item => item.type === 'dispatch-intended')).toBe(false);
    } finally {
      store.close();
    }
  });
});
