import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { spec as baseSpec, proposal, sourceText } from './domain/fixtures.test-support.js';
import { ProjectJournal } from './store/journal.js';
import { newEvent } from './app/events.js';
import { UserError } from './domain/errors.js';
import type { GoalSpec } from './domain/contracts.js';
import type { WorkPackageSpec } from './domain/packages.js';
import type { BotIdentity, BotWakeInput, HandoffInput, PackageRuntime, RuntimeAdapter } from './ports/runtime.js';

const spec: GoalSpec = {
  ...baseSpec,
  checks: [
    { id: 'CHK-1', kind: 'command', command: 'node harness.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
  ],
};
const BOT: BotIdentity = { id: 'bot-lead-apos', name: 'Lead APOS' };
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ORCA_TERMINAL_HANDLE;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
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
const fix: WorkPackageSpec = {
  ...a,
  id: 'WP-03',
  owner: 'worker-c',
  outcome: 'Review fixes',
  scope: ['fix'],
  dependencies: ['WP-02'],
  acceptance: [{ id: 'WP-AC-3', text: 'review comments addressed' }],
};

/** A Multi-WP Goal planned by an APOS Lead, with a fake Orca that also knows one bot and can say which chat calls. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-bot-multi-'));
  dirs.push(dir);
  const leadTree = mkdtempSync(join(tmpdir(), 'apos-bot-multi-lead-'));
  dirs.push(leadTree);
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-bot-multi-art-'));
  dirs.push(artifacts);
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
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.json\nbrief.md\n');
  writeFileSync(join(dir, 'brief.md'), sourceText);
  const harness = commit('harness.js', "require('./feature.js');", 'harness');
  const starts: string[] = [];
  const resumes: string[] = [];
  const handoffs: HandoffInput[] = [];
  const mails: BotWakeInput[] = [];
  const told: string[] = [];
  const stops: string[] = [];
  const inspected: string[] = [];
  let stopResult: 'stopped' | 'unknown' = 'stopped';
  let caller: BotIdentity | undefined;
  let callerError: Error | undefined;
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startLead({ repoPath }) {
      return {
        runId: 'run_lead',
        taskId: 'lead',
        dispatchId: 'lead-1',
        owner: 'lead',
        repoPath,
        terminal: 'term_lead',
        worktreeId: `repo::${leadTree}`,
        baseCommit: git('rev-parse', 'HEAD'),
      };
    },
    async resumeSolo() {
      throw new Error('Solo must not resume');
    },
    async inspect(ref) {
      inspected.push(ref.dispatchId);
      return { state: 'live', ref };
    },
    async stopWorker(dispatchId) {
      stops.push(dispatchId);
      return stopResult;
    },
    async handoff(item) {
      handoffs.push(item);
      return {
        runId: 'run_lead',
        taskId: 'lead2',
        dispatchId: 'lead-2',
        owner: 'lead',
        repoPath: dir,
        terminal: 'term_lead2',
      };
    },
    async inspectPackage() {
      return 'completed';
    },
    async startPackage({ package: item, repoPath }) {
      starts.push(item.id);
      return {
        runId: 'run_1',
        taskId: item.id,
        dispatchId: item.id,
        owner: 'worker',
        repoPath,
        baseCommit: git('rev-parse', 'HEAD'),
      };
    },
    async resumePackage({ package: item, prior }) {
      resumes.push(`${item.id}:${prior.dispatchId}`);
      return { ...prior, dispatchId: `${item.id}-r` };
    },
    findBot: nameOrId => ([BOT.id, BOT.name].includes(nameOrId) ? BOT : undefined),
    callerBot: () => {
      if (callerError) throw callerError;
      return caller;
    },
    async wakeBot(item) {
      mails.push(item);
      return { messageId: `msg_${mails.length}` };
    },
    async tellBot(bot, subject) {
      told.push(`${bot.id}:${subject}`);
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
  const asLead = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_lead';
    try {
      return await fn();
    } finally {
      delete process.env.ORCA_TERMINAL_HANDLE;
    }
  };
  await invoke('init');
  await invoke('goal', 'create', '--file', input('goal.json', spec), '--source', join(dir, 'brief.md'));
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
  await asLead(async () => {
    await invoke('lead', 'propose', '--file', input('proposal.json', { ...proposal, mode: 'multi-wp' }));
    await invoke('package', 'add', '--file', input('wp-a.json', a), '--reason', 'First stage');
    await invoke('package', 'add', '--file', input('wp-b.json', b), '--reason', 'Second stage');
    await invoke('lead', 'commit', spec.id);
  });
  const journal = () => {
    const opened = ProjectJournal.open(dir);
    try {
      return { goal: opened.journal.getGoal(spec.id)!, events: opened.journal.events(spec.id) };
    } finally {
      opened.close();
    }
  };
  const evidence = (pkg: WorkPackageSpec, acceptanceId: string, commitRef: string, version = 1) =>
    input(`ev-${pkg.id}-${version}.json`, {
      packageId: pkg.id,
      packageVersion: version,
      owner: pkg.owner,
      acceptanceId,
      result: 'pass',
      command: 'npm test',
      artifactRef: `log:${pkg.id}`,
      commitRef,
    });
  const review = (result: 'pass' | 'changes', commitRef: string, note: string) =>
    input(`review-${commitRef.slice(0, 8)}-${result}.json`, {
      subject: 'goal',
      reviewer: 'reviewer-agent',
      session: `review-${commitRef.slice(0, 8)}`,
      result,
      commitRef,
      note,
    });
  return {
    dir,
    leadTree,
    harness,
    commit,
    input,
    invoke,
    asBot,
    asLead,
    journal,
    evidence,
    review,
    output,
    starts,
    resumes,
    handoffs,
    mails,
    told,
    stops,
    inspected,
    setStop: (value: 'stopped' | 'unknown') => (stopResult = value),
    setCallerError: (error: Error | undefined) => (callerError = error),
  };
}

describe('the Lead of a Multi-WP Goal moved to an Orca bot', () => {
  it('refuses the transfer unless Orca confirms the Lead stopped, and records it when it does', async () => {
    const t = await setup();
    await expect(t.invoke('handoff', spec.id, '--to-bot', 'Nobody', '--by', 'anh')).rejects.toThrow(
      /No Orca bot Nobody/,
    );
    t.setStop('unknown');
    await expect(t.invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh')).rejects.toThrow(
      /Could not confirm the Lead stopped/,
    );
    expect(t.journal().goal.leadBot).toBeUndefined();
    expect(
      t
        .journal()
        .events.slice(-2)
        .map(item => item.type),
    ).toEqual(['handoff-intended', 'intent-abandoned']);
    t.setStop('stopped');
    await t.invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh');
    const { goal, events } = t.journal();
    expect(goal.leadBot).toMatchObject({ id: BOT.id, name: 'Lead APOS', by: 'anh' });
    expect(events.find(item => item.type === 'lead-transferred')?.data).toMatchObject({
      from: 'lead-1',
      by: 'anh',
      bot: { id: BOT.id, name: 'Lead APOS' },
    });
    expect(t.stops).toEqual(['lead-1', 'lead-1']);
    expect(t.mails[0]).toMatchObject({ bot: BOT, mode: 'multi', leadWorktree: t.leadTree });
    expect(existsSync(join(t.leadTree, '.apos', 'goals', spec.id, 'lead-log.md'))).toBe(true);
  });

  it('refuses every Human command from the bot, wherever it runs, and fails closed when Orca cannot tell', async () => {
    const t = await setup();
    await t.invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh');
    const appetite = ['--size', 'L', '--max-spend', '99', '--max-minutes', '999', '--max-attempts', '9'];
    const human: string[][] = [
      ['goal', 'approve', spec.id, ...appetite],
      ['goal', 'select', spec.id],
      ['goal', 'appetite', spec.id, ...appetite, '--reason', 'more'],
      ['lead', 'start', spec.id],
      ['lead', 'wake', spec.id, '--note', 'go'],
      ['handoff', spec.id],
      ['handoff', spec.id, '--to-apos'],
      ['handoff', spec.id, '--to-bot', 'Lead APOS'],
      ['handoff', spec.id, '--package', 'WP-01'],
      ['gate', 'run', spec.id, '--commit', t.harness, '--base', t.harness],
      ['gate', 'confirm', spec.id, 'CHK-1', '--commit', t.harness, '--by', 'bot', '--note', 'ok'],
      ['review', 'submit', spec.id, '--file', t.review('pass', t.harness, 'self review')],
      ['blocker', 'resolve', spec.id, '--note', 'fine'],
      ['outcome', 'close', spec.id],
      ['outcome', 'revise', spec.id],
      ['outcome', 'stop', spec.id],
      ['profile', 'set', 'worker', '--agent', 'claude'],
      ['profile', 'reset'],
      ['execution', 'abandon-intent', spec.id, '--key', 'k', '--reason', 'r'],
    ];
    // Outside every APOS worktree and terminal: only the bot check can refuse.
    expect(process.env.ORCA_TERMINAL_HANDLE).toBeUndefined();
    for (const args of human)
      await expect(
        t.asBot(() => t.invoke(...args)),
        args.join(' '),
      ).rejects.toThrow(/is a Human decision and cannot run from bot Lead APOS/);
    await expect(t.asBot(() => t.invoke('goal', 'select', spec.id))).rejects.toBeInstanceOf(UserError);
    await expect(
      t.asLead(() => t.invoke('package', 'approve', spec.id, 'WP-02', '--reason', 'old')),
    ).rejects.toBeInstanceOf(UserError);
    t.setCallerError(new Error('Orca down'));
    await expect(t.invoke('goal', 'select', spec.id)).rejects.toThrow(/could not say whether this session is that bot/);
    await expect(t.invoke('goal', 'select', spec.id)).rejects.toBeInstanceOf(UserError);
    t.setCallerError(undefined);
    expect(t.journal().goal.leadBot).toMatchObject({ id: BOT.id });
  });

  it('takes Lead commands only from the bot, integrates on a verified package head, and fixes a review by packages', async () => {
    const t = await setup();
    await t.invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh');
    // The stopped Lead's terminal, and any process in its worktree, no longer speak for the Lead.
    await expect(
      t.asLead(() => t.invoke('package', 'approve', spec.id, 'WP-02', '--reason', 'old Lead')),
    ).rejects.toThrow(/is bot Lead APOS/);
    vi.spyOn(process, 'cwd').mockReturnValue(t.leadTree);
    await expect(t.invoke('package', 'approve', spec.id, 'WP-02', '--reason', 'in the tree')).rejects.toThrow(
      /is bot Lead APOS/,
    );
    vi.restoreAllMocks();
    const commitA = t.commit('scanner.ts', 'export const scan = true;', 'scanner');
    const commitB = t.commit('feature.js', 'process.exit(0);', 'history');
    await t.asBot(async () => {
      await t.invoke('package', 'evidence', spec.id, '--file', t.evidence(a, 'WP-AC-1', commitA));
      await t.invoke('package', 'verify', spec.id, 'WP-01');
      await t.invoke('package', 'approve', spec.id, 'WP-02', '--reason', 'WP-01 checked');
      await t.invoke('package', 'dispatch', spec.id);
      await t.invoke('package', 'evidence', spec.id, '--file', t.evidence(b, 'WP-AC-2', commitB));
      await t.invoke('package', 'verify', spec.id, 'WP-02');
      // The bot asks for its gate with a reason; a bare gate run and a commit it could have written are refused.
      await expect(t.invoke('gate', 'run', spec.id, '--commit', commitB)).rejects.toThrow(/use apos integration gate/);
      await expect(t.invoke('integration', 'gate', spec.id, '--commit', t.harness, '--reason', 'mine')).rejects.toThrow(
        /never writes code/,
      );
      await t.invoke('integration', 'gate', spec.id, '--commit', commitB, '--reason', 'WP-02 is the end of the chain');
    });
    expect(t.starts).toEqual(['WP-01', 'WP-02']);
    expect(t.output.at(-1)).toBe(`Integration gate green on ${commitB}`);
    expect(t.journal().events.find(item => item.type === 'integration-gate-requested')?.data).toEqual({
      commit: commitB,
      reason: 'WP-02 is the end of the chain',
      by: 'bot:Lead APOS',
    });
    // The Goal review asks for changes: the bot adds a fix package for a Worker.
    await t.invoke('review', 'submit', spec.id, '--file', t.review('changes', commitB, 'Handle expired tokens'));
    await t.asBot(async () => {
      await t.invoke(
        'package',
        'add',
        '--file',
        t.input('wp-fix.json', fix),
        '--reason',
        'Review: handle expired tokens',
      );
      await t.invoke('package', 'approve', spec.id, 'WP-03', '--reason', 'Fix package for the review');
      await t.invoke('package', 'dispatch', spec.id);
    });
    expect(t.starts).toEqual(['WP-01', 'WP-02', 'WP-03']);
    expect(t.journal().goal.packages?.['WP-03']?.status).toBe('executing');
    const commitC = t.commit('fix.ts', 'export const expired = false;', 'fix');
    await t.asBot(async () => {
      await t.invoke('package', 'evidence', spec.id, '--file', t.evidence(fix, 'WP-AC-3', commitC));
      await t.invoke('package', 'verify', spec.id, 'WP-03');
      await t.invoke('integration', 'gate', spec.id, '--commit', commitC, '--reason', 'Fix package head');
    });
    // Changes again: this time the bot revises the last package so its own owner resumes with the comments.
    await t.invoke('review', 'submit', spec.id, '--file', t.review('changes', commitC, 'Also log the rejection'));
    await t.asBot(async () => {
      await t.invoke(
        'package',
        'revise',
        spec.id,
        '--file',
        t.input('wp-fix-2.json', { ...fix, version: 2, outcome: 'Review fixes; also log the rejection' }),
        '--reason',
        'Review: also log the rejection',
      );
      await t.invoke('package', 'approve', spec.id, 'WP-03', '--reason', 'Revised for the second review');
      await t.invoke('package', 'resume', spec.id, 'WP-03');
    });
    expect(t.resumes).toEqual(['WP-03:WP-03']);
    expect(t.journal().goal.packages?.['WP-03']?.status).toBe('executing');
    const commitC2 = t.commit('fix.ts', 'export const expired = false; // logged', 'fix 2');
    await t.asBot(async () => {
      await t.invoke('package', 'evidence', spec.id, '--file', t.evidence(fix, 'WP-AC-3', commitC2, 2));
      await t.invoke('package', 'verify', spec.id, 'WP-03');
      await t.invoke('integration', 'gate', spec.id, '--commit', commitC2, '--reason', 'Revised fix head');
    });
    await t.invoke('review', 'submit', spec.id, '--file', t.review('pass', commitC2, 'Looks right'));
    await t.asBot(() => t.invoke('integration', 'complete', spec.id, '--commit', commitC2));
    const { goal, events } = t.journal();
    expect(goal.status).toBe('verified');
    // Each coordination decision is its own event with its reason (the first two are the APOS Lead's plan).
    expect(
      events
        .filter(item => ['package-plan-added', 'package-revised', 'package-dispatch-approved'].includes(item.type))
        .map(item => (item.data as { reason?: string }).reason),
    ).toEqual([
      'First stage',
      'Second stage',
      'WP-01 checked',
      'Review: handle expired tokens',
      'Fix package for the review',
      'Review: also log the rejection',
      'Revised for the second review',
    ]);
    await expect(t.asBot(() => t.invoke('outcome', 'close', spec.id))).rejects.toThrow(/Human decision/);
  }, 60_000);

  it('wakes the bot from controller tick through Orca, never inspecting, waking or gating the stopped Lead', async () => {
    const t = await setup();
    await t.invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh');
    const commitA = t.commit('scanner.ts', 'export const scan = true;', 'scanner');
    await t.asBot(async () => {
      await t.invoke('package', 'evidence', spec.id, '--file', t.evidence(a, 'WP-AC-1', commitA));
      await t.invoke('package', 'verify', spec.id, 'WP-01');
    });
    t.inspected.length = 0;
    const before = t.mails.length;
    await t.invoke('controller', 'tick');
    const mail = t.mails.slice(before).find(item => item.mode === 'multi');
    expect(mail?.events.join(' | ')).toMatch(/package WP-02 v1 awaits Lead dispatch approval/);
    expect(t.inspected).not.toContain('lead-1');
    const { events } = t.journal();
    expect(events.some(item => item.type === 'gate-recorded')).toBe(false);
    const woken = events.filter(item => item.type === 'lead-woken').at(-1)?.data as { bot?: string; events?: string[] };
    expect(woken.bot).toBe(BOT.id);
    expect(existsSync(join(t.leadTree, '.apos', 'goals', spec.id, 'lead-log.md'))).toBe(true);
    // Nothing new: the next tick sends no second mail.
    const sent = t.mails.length;
    await t.invoke('controller', 'tick');
    expect(t.mails.length).toBe(sent);
  });

  it('refuses to give the Lead back while a reviewer start is pending, before telling the bot anything', async () => {
    const t = await setup();
    await t.invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh');
    const commitA = t.commit('scanner.ts', 'export const scan = true;', 'scanner');
    const commitB = t.commit('feature.js', 'process.exit(0);', 'history');
    await t.asBot(async () => {
      await t.invoke('package', 'evidence', spec.id, '--file', t.evidence(a, 'WP-AC-1', commitA));
      await t.invoke('package', 'verify', spec.id, 'WP-01');
      await t.invoke('package', 'approve', spec.id, 'WP-02', '--reason', 'WP-01 checked');
      await t.invoke('package', 'dispatch', spec.id);
      await t.invoke('package', 'evidence', spec.id, '--file', t.evidence(b, 'WP-AC-2', commitB));
      await t.invoke('package', 'verify', spec.id, 'WP-02');
      await t.invoke('integration', 'gate', spec.id, '--commit', commitB, '--reason', 'end of the chain');
    });
    const opened = ProjectJournal.open(t.dir);
    opened.journal.append(newEvent(spec.id, 'review-intended', { key: 'rk', commit: commitB }));
    opened.close();
    await expect(t.invoke('handoff', spec.id, '--to-apos', '--by', 'anh')).rejects.toThrow(/pending/);
    expect(t.journal().events.some(item => item.type === 'lead-returned')).toBe(false);
    expect(t.journal().goal.leadBot).toMatchObject({ id: BOT.id });
    expect(t.told).toEqual([]);
  });

  it('refuses to give the Lead back while the Goal is blocked for a reason a fresh Lead cannot clear', async () => {
    const t = await setup();
    await t.invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh');
    await t.invoke('blocker', 'report', spec.id, '--kind', 'external', '--note', 'Test service unavailable');
    await expect(t.invoke('handoff', spec.id, '--to-apos', '--by', 'anh')).rejects.toThrow(
      /blocked for another reason/,
    );
    expect(t.journal().events.some(item => item.type === 'lead-returned')).toBe(false);
    expect(t.told).toEqual([]);
  });

  it('gives the Lead back to a fresh APOS Lead on a Human command, recorded as an event', async () => {
    const t = await setup();
    await t.invoke('handoff', spec.id, '--to-bot', 'Lead APOS', '--by', 'anh');
    await expect(t.invoke('handoff', spec.id)).rejects.toThrow(/--to-apos/);
    await t.invoke('handoff', spec.id, '--to-apos', '--by', 'anh');
    expect(t.told).toEqual([`${BOT.id}:APOS ${spec.id}: Lead role ended`]);
    expect(t.handoffs.map(item => item.kind)).toEqual(['lead-multi']);
    const { goal, events } = t.journal();
    expect(goal.leadBot).toBeUndefined();
    expect(goal.lead?.current).toBe('lead-2');
    expect(events.slice(-3).map(item => item.type)).toEqual(['lead-returned', 'handoff-intended', 'owner-handed-off']);
    expect(events.find(item => item.type === 'lead-returned')?.data).toEqual({ by: 'anh', botId: BOT.id });
    await expect(t.asBot(() => t.invoke('package', 'approve', spec.id, 'WP-02', '--reason', 'late'))).rejects.toThrow(
      /must run from the Lead terminal/,
    );
  });
});
