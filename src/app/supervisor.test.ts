import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { spec as baseSpec, proposal, sourceText } from '../domain/fixtures.test-support.js';
import type { GoalSpec } from '../domain/contracts.js';
import { ESCALATION_REPLY } from './controller.js';
import { CORE_SKILL, activationLine, committedFileDigest, reviewResultPath, soloReportPath } from '../runtime/brief.js';
import { ProjectJournal } from '../store/journal.js';
import { SqliteStore } from '../store/sqlite.js';
import { buildInbox } from './inbox.js';
import { SoloSupervisor } from './solo-supervisor.js';
import { SoloService } from './solo.js';
import { OrcaRefused } from '../runtime/orca/exec.js';
import { composerHasUnsentBrief } from '../runtime/orca/parse.js';
import { unsentBrief } from '../runtime/screens.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { approval } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { OrcaMessage, RuntimeAdapter } from '../ports/runtime.js';
import type { Budget, RuntimeRef } from '../domain/runtime-refs.js';

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
const APPETITE = ['--size', 'M', '--max-spend', '20', '--max-minutes', '240', '--max-attempts', '3'];
/** Runs `fn` as the Lead Orca dispatched: its terminal handle is the one APOS recorded. */
async function asLead<T>(terminal: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = terminal;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = before;
  }
}

/**
 * A fake Orca whose "owner" works directly in the repo checkout (its worktree). Each dispatch runs the
 * scripted work for that attempt, then settles. Everything else - gate, findings, resume, review,
 * verification, merge - is the real controller on real Git.
 */
async function setup(
  work: (attempt: number, commit: (files: Record<string, string>, message: string) => void, line: string) => void,
  options: {
    risks?: string[];
    reviewer?: (commit: (files: Record<string, string>) => void, key: string) => void;
    launched?: string;
    intrude?: boolean;
    failed?: (attempt: number) => boolean;
    inbox?: OrcaMessage[];
    reviewerUnknown?: boolean;
    refuseResumes?: number;
    hungIdleMinutes?: number;
    manualCheck?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-auto-'));
  dirs.push(dir);
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-auto-art-'));
  dirs.push(artifacts);
  execFileSync('git', ['init', '-q', dir]);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'harness.js'), "require('./feature.js');");
  git('add', 'harness.js');
  git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'harness');
  let owner = '';
  const commitIn = (cwd: string) => (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(cwd, name, '..'), { recursive: true });
      writeFileSync(join(cwd, name), content);
    }
    execFileSync('git', ['-C', cwd, 'add', '--', ...Object.keys(files)]);
    execFileSync('git', [
      '-C',
      cwd,
      '-c',
      'user.name=Owner',
      '-c',
      'user.email=o@local.invalid',
      'commit',
      '-qm',
      message,
    ]);
  };
  const commit = (files: Record<string, string>, message: string) =>
    commitIn(options.intrude ? dir : owner)(files, message);
  let attempt = 0;
  const dispatches: string[] = [];
  const settled = new Set<string>();
  const released: string[] = [];
  const failedDispatches = new Set<string>();
  const budgets: (Budget | undefined)[] = [];
  const replies: { messageId: string; body: string }[] = [];
  const acked: string[] = [];
  let inbox = options.inbox ?? [];
  let reviewKey: string | undefined;
  let lostReviewer: RuntimeRef | undefined;
  let refusals = 0;
  const ref = (n: number): RuntimeRef => ({
    runId: 'run_1',
    taskId: `task_${n}`,
    dispatchId: `ctx_${n}`,
    owner: 'lead',
    repoPath: dir,
    terminal: 'term_1',
    worktreeId: `repo::${owner}`,
    baseCommit: base,
    requested: { agent: 'codex', model: 'gpt-6.1-terra' },
  });
  let base = '';
  const runOwner = () => {
    attempt += 1;
    work(attempt, commit, activationLine(committedFileDigest(dir, base, CORE_SKILL)));
    if (options.hungIdleMinutes === undefined) settled.add(`ctx_${attempt}`);
    if (options.failed?.(attempt)) failedDispatches.add(`ctx_${attempt}`);
  };
  const runtime: RuntimeAdapter = {
    // The Lead: its own worktree at the base it plans from. It delivers (runOwner) after lead commit accepts its Solo plan.
    async startLead(input) {
      budgets.push(input.budget);
      base = git('rev-parse', 'HEAD');
      dispatches.push('start');
      owner = join(mkdtempSync(join(tmpdir(), 'apos-auto-wt-')), 'wt');
      dirs.push(join(owner, '..'));
      git('worktree', 'add', '-q', '-b', 'owner', owner, base);
      return ref(1);
    },
    async resumeSolo(_ref, _checkpoint, _key, budget) {
      if (refusals < (options.refuseResumes ?? 0)) {
        refusals += 1;
        throw new OrcaRefused('agent_unconfigured', 'agent_unconfigured');
      }
      budgets.push(budget);
      dispatches.push('resume');
      const r = ref(attempt + 1);
      runOwner();
      return r;
    },
    async inspect(r) {
      if (options.hungIdleMinutes !== undefined && !settled.has(r.dispatchId))
        return { state: 'live', idleMinutes: options.hungIdleMinutes, ref: r };
      return settled.has(r.dispatchId)
        ? { state: 'settled', outcome: failedDispatches.has(r.dispatchId) ? 'failed' : 'completed', ref: r }
        : { state: 'live', ref: r };
    },
    async deliveryHead(r) {
      return execFileSync('git', ['-C', r.worktreeId ? r.worktreeId.split('::')[1] : owner, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
    },
    async launchReceipt() {
      return { agent: 'codex', model: options.launched ?? 'gpt-6.1-terra' };
    },
    async startReviewer(input) {
      reviewKey = input.idempotencyKey;
      const reviewWt = join(mkdtempSync(join(tmpdir(), 'apos-auto-rv-')), 'wt');
      dirs.push(join(reviewWt, '..'));
      git('worktree', 'add', '-q', '--detach', reviewWt, input.commit);
      options.reviewer?.(files => commitIn(reviewWt)(files, 'review'), input.idempotencyKey);
      settled.add('ctx_review');
      if (options.reviewerUnknown) {
        lostReviewer = {
          runId: 'run_1',
          taskId: 'task_r',
          dispatchId: 'ctx_review',
          owner: 'lead',
          repoPath: dir,
          worktreeId: `repo::${reviewWt}`,
        };
        throw new Error('Orca orchestration worker-start failed: state=outcome_unknown');
      }
      return {
        runId: 'run_1',
        taskId: 'task_r',
        dispatchId: 'ctx_review',
        owner: 'reviewer',
        repoPath: dir,
        worktreeId: `repo::${reviewWt}`,
        key: input.idempotencyKey,
        commit: input.commit,
      };
    },
    async releaseWorker(dispatchId) {
      released.push(dispatchId);
    },
    async recover(key) {
      return lostReviewer && key === reviewKey ? lostReviewer : undefined;
    },
    ...(options.inbox
      ? {
          async checkRun() {
            return { messages: inbox };
          },
          async ackRun(_run: string, handled: string[]) {
            acked.push(...handled);
            inbox = [];
            return [];
          },
          async retainWorker() {},
          async replyMessage(_run: string, messageId: string, body: string) {
            replies.push({ messageId, body });
          },
        }
      : {}),
  };
  const output: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { runtime, gate: { artifactRoot: artifacts }, write: line => output.push(line) });
  const goalSpec: GoalSpec = options.manualCheck
    ? {
        ...spec,
        checks: [
          ...spec.checks,
          { id: 'CHK-M', kind: 'manual', procedure: 'Open the page', expectedResult: 'It renders' },
        ],
        acceptance: spec.acceptance.map(item => ({ ...item, checkIds: [...item.checkIds, 'CHK-M'] })),
      }
    : spec;
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(goalSpec));
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ ...proposal, risks: options.risks ?? [] }));
  writeFileSync(join(dir, '.git', 'info', 'exclude'), 'goal.json\nbrief.md\nplan.json\n');
  await invoke('init');
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  await invoke('goal', 'approve', spec.id, ...APPETITE);
  await invoke('goal', 'select', spec.id);
  await asLead('term_1', async () => {
    await invoke('lead', 'propose', '--file', join(dir, 'plan.json'));
    await invoke('lead', 'commit', spec.id);
  });
  runOwner();
  const tick = async () => {
    await invoke('controller', 'tick');
    return output.at(-1)!;
  };
  const state = () => {
    const opened = ProjectJournal.open(dir);
    try {
      return opened.journal.getGoal(spec.id)!;
    } finally {
      opened.close();
    }
  };
  return {
    dir,
    git,
    invoke,
    tick,
    state,
    dispatches,
    released,
    output,
    reviewKeyOf: () => reviewKey,
    budgets,
    replies,
    acked,
  };
}

const report = (attempt: number, line: string) => ({
  [soloReportPath(spec.id, attempt)]: `# Delivery\n\n${line}\nreviewedHead: HEAD\n`,
});

describe('Solo autopilot', () => {
  it('turns a red gate into a machine finding, resumes the same owner, then verifies the fix', async () => {
    const { tick, state, dispatches, invoke, git, released } = await setup((attempt, commit, line) => {
      commit(
        { 'feature.js': attempt === 1 ? 'process.exit(1);' : 'process.exit(0);', ...report(attempt, line) },
        `attempt ${attempt}`,
      );
    });
    await tick();
    await tick();
    expect(dispatches).toEqual(['start', 'resume']);
    const findings = state().findings!;
    expect(findings[0]).toMatchObject({ kind: 'patch', by: 'controller', checkIds: ['CHK-1'] });
    expect(findings[0].note).toMatch(/Controller gate red/);
    await tick();
    expect(state()).toMatchObject({ status: 'verified', soloAttempts: 2 });
    expect(state().telemetry?.map(item => item.dispatchId)).toEqual(['ctx_1', 'ctx_2']);
    await invoke('outcome', 'close', spec.id, '--merge-to', git('branch', '--show-current'));
    expect(state().status).toBe('closed');
    expect(state().postMergeGate?.result).toBe('green');
    expect(released).toEqual(['ctx_1', 'ctx_2']);
  }, 90_000);

  it('sends the Goal to a Human decision when the same failure survives two repairs', async () => {
    const { tick, state, dispatches } = await setup((attempt, commit, line) =>
      commit({ 'feature.js': 'process.exit(1);', ...report(attempt, line) }, `attempt ${attempt}`),
    );
    for (let i = 0; i < 4; i++) await tick();
    expect(dispatches).toEqual(['start', 'resume', 'resume']);
    expect(state()).toMatchObject({
      status: 'blocked',
      blocker: { note: expect.stringMatching(/needs-decision: same failure after two repairs/) },
    });
  }, 90_000);

  it('does not accept a delivery whose report lacks the core activation line', async () => {
    const { tick, state, dispatches } = await setup((attempt, commit, line) =>
      commit(
        { 'feature.js': 'process.exit(0);', ...report(attempt, attempt === 1 ? 'no activation' : line) },
        `attempt ${attempt}`,
      ),
    );
    await tick();
    await tick();
    await tick();
    expect(dispatches).toEqual(['start', 'resume']);
    expect(state().findings![0].note).toMatch(/activation line/);
    expect(state().status).toBe('verified');
  }, 90_000);

  it('tells the Human once when an unsettled owner has sat idle past the quiet spell (a dead launch looks like this)', async () => {
    const { tick, state, output } = await setup(
      (attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'),
      { hungIdleMinutes: 20 },
    );
    await tick();
    await tick();
    await tick();
    expect(state().status).toBe('executing');
    expect(output.filter(line => line.includes('idle 20 min; Human notified'))).toHaveLength(1);
    expect(state().findings ?? []).toHaveLength(0);
  }, 90_000);

  it('stops for a decision when the runtime launched a different model than planned', async () => {
    const { tick, state } = await setup(
      (attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'),
      { launched: 'gpt-6-luna' },
    );
    await tick();
    await tick();
    expect(state().blocker).toMatchObject({
      note: expect.stringMatching(/launched codex\/gpt-6-luna, plan requires codex\/gpt-6.1-terra/),
    });
  }, 90_000);

  it('sends a risky green delivery to a separate reviewer session and verifies only on its pass', async () => {
    const { tick, state } = await setup(
      (attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'),
      {
        risks: ['auth regression'],
        reviewer: (commit, key) =>
          commit({
            [reviewResultPath(spec.id, key)]: JSON.stringify({
              result: 'pass',
              note: 'Checked auth paths and boundaries',
            }),
          }),
      },
    );
    // lead commit dispatched the owner; the first tick gates its delivery green and starts the reviewer.
    expect(await tick()).toContain('reviewer ctx_review');
    expect(state()).toMatchObject({ status: 'executing', reviewDispatch: { dispatchId: 'ctx_review' } });
    expect(await tick()).toContain('review pass');
    expect(state().reviews[0]).toMatchObject({ reviewer: 'apos-reviewer', session: 'ctx_review', result: 'pass' });
    expect(state().status).toBe('verified');
  }, 90_000);

  it('recovers a reviewer Orca created but reported as outcome unknown (seen live on SQLFMT)', async () => {
    const { tick, state } = await setup(
      (attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'),
      {
        risks: ['auth regression'],
        reviewerUnknown: true,
        reviewer: (commit, key) =>
          commit({ [reviewResultPath(spec.id, key)]: JSON.stringify({ result: 'pass', note: 'Checked auth paths' }) }),
      },
    );
    expect(await tick()).toContain('reviewer start outcome unknown');
    expect(state()).toMatchObject({ status: 'executing', reviewIntent: { commit: expect.any(String) } });
    expect(await tick()).toContain('recovered reviewer ctx_review');
    expect(await tick()).toContain('review pass');
    expect(state().status).toBe('verified');
  }, 90_000);

  it('retries a refused resume after a review asks for changes on a green gate (seen live on SQLFMT)', async () => {
    const { tick, dispatches } = await setup(
      (attempt, commit, line) =>
        commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, `attempt ${attempt}`),
      {
        risks: ['auth regression'],
        refuseResumes: 1,
        reviewer: (commit, key) =>
          commit({
            [reviewResultPath(spec.id, key)]: JSON.stringify(
              dispatches.length === 1
                ? { result: 'changes', note: 'Comma lands inside a comment' }
                : { result: 'pass', note: 'Fixed' },
            ),
          }),
      },
    );
    await tick();
    expect(await tick()).toContain('resume refused, will retry');
    expect(await tick()).toContain('resumed owner');
    expect(dispatches).toEqual(['start', 'resume']);
  }, 90_000);

  it('turns a reviewer request for changes into a finding for the same owner', async () => {
    let reviews = 0;
    const { tick, state, dispatches } = await setup(
      (attempt, commit, line) =>
        commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, `attempt ${attempt}`),
      {
        risks: ['auth regression'],
        reviewer: (commit, key) => {
          reviews += 1;
          commit({
            [reviewResultPath(spec.id, key)]: JSON.stringify(
              reviews === 1
                ? { result: 'changes', note: 'src/auth.ts: expired token still accepted' }
                : { result: 'pass', note: 'Fixed' },
            ),
          });
        },
      },
    );
    await tick();
    await tick();
    expect(dispatches).toEqual(['start', 'resume']);
    expect(state().findings![0].note).toMatch(/expired token still accepted/);
    await tick();
    await tick();
    expect(state().status).toBe('verified');
  }, 90_000);

  it('does not block a Goal for an ordinary Human commit on the managed checkout during the attempt', async () => {
    const { tick, state, git, dir } = await setup((attempt, commit, line) =>
      commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'),
    );
    // The owner is done; meanwhile anh commits unrelated work on the managed checkout.
    writeFileSync(join(dir, 'notes.md'), 'unrelated');
    git('add', 'notes.md');
    git('-c', 'user.name=Anh', '-c', 'user.email=anh@local.invalid', 'commit', '-qm', 'unrelated human work');
    await tick();
    expect(state().status).toBe('verified');
  }, 90_000);

  it('stops for a decision when the owner commits into the managed checkout instead of its worktree', async () => {
    const { tick, state } = await setup(
      (attempt, commit, line) =>
        commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work in the wrong place'),
      { intrude: true },
    );
    await tick();
    expect(state().blocker).toMatchObject({
      note: expect.stringMatching(/needs-decision: the owner.s delivery landed in the managed checkout/),
    });
  }, 90_000);
});

describe('manual check waiting on the Human', () => {
  it('records one gate and one notice for a commit however many ticks pass, and clears the notice once confirmed', async () => {
    const { tick, state, invoke, dir } = await setup(
      (attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'),
      { manualCheck: true },
    );
    const events = () => {
      const opened = ProjectJournal.open(dir);
      try {
        return opened.journal.events(spec.id);
      } finally {
        opened.close();
      }
    };
    const count = (type: string, kind?: string) =>
      events().filter(item => item.type === type && (!kind || (item.data as { kind?: string }).kind === kind)).length;
    for (let i = 0; i < 4; i++) await tick();
    expect(state().status).toBe('executing');
    expect(count('gate-recorded')).toBe(1);
    expect(count('human-notified', 'manual-check')).toBe(1);
    const commit = state().gate!.deliveryCommit;
    await invoke('gate', 'confirm', spec.id, 'CHK-M', '--commit', commit, '--by', 'reviewer', '--note', 'looked fine');
    await tick();
    expect(state().status).toBe('verified');
    const inbox: string[] = [];
    const opened = ProjectJournal.open(dir);
    try {
      inbox.push(...buildInbox(opened.journal).map(item => `${item.kind}:${item.detail}`));
    } finally {
      opened.close();
    }
    expect(inbox.some(line => line.includes('manual-check'))).toBe(false);
  }, 90_000);
});

describe('manual check on the merge commit', () => {
  it('lets the Human confirm a manual check on the merge commit and close the Goal once the post-merge gate is green', async () => {
    const { tick, state, invoke, git } = await setup(
      (attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'),
      { manualCheck: true },
    );
    await tick();
    await invoke(
      'gate',
      'confirm',
      spec.id,
      'CHK-M',
      '--commit',
      state().gate!.deliveryCommit,
      '--by',
      'reviewer',
      '--note',
      'ok on delivery',
    );
    await tick();
    expect(state().status).toBe('verified');
    const branch = git('branch', '--show-current');
    await expect(invoke('outcome', 'close', spec.id, '--merge-to', branch)).rejects.toThrow(
      /Post-merge gate is pending/,
    );
    expect(state()).toMatchObject({ status: 'verified', postMergeGate: { result: 'pending' } });
    await invoke(
      'gate',
      'confirm',
      spec.id,
      'CHK-M',
      '--commit',
      state().merge!.mergeCommit,
      '--by',
      'reviewer',
      '--note',
      'ok on merge commit',
    );
    await invoke('outcome', 'close', spec.id);
    expect(state()).toMatchObject({ status: 'closed', postMergeGate: { result: 'green' } });
  }, 90_000);
});

describe('owner stops early (seen live on SQLFMT)', () => {
  it('resumes an owner that reported failed with budget left, quoting its own Remaining list, and tells it the budget', async () => {
    const { tick, state, dispatches, budgets } = await setup(
      (attempt, commit, line) => {
        const body =
          attempt === 1
            ? `# Solo attempt: incomplete

${line}

## Remaining

Lowercase TRUE and FALSE literals.
`
            : `# Delivery

${line}

## Remaining

none
`;
        commit({ 'feature.js': 'process.exit(0);', [soloReportPath(spec.id, attempt)]: body }, `attempt ${attempt}`);
      },
      { failed: attempt => attempt === 1 },
    );
    await tick();
    expect(dispatches).toEqual(['start', 'resume']);
    expect(state().findings![0]).toMatchObject({ kind: 'patch', by: 'controller', signature: 'owner-incomplete' });
    expect(state().findings![0].note).toMatch(/Lowercase TRUE and FALSE literals/);
    expect(budgets[0]).toMatchObject({ attemptsLeft: 2 });
    expect(budgets[0]!.minutesLeft).toBeGreaterThan(239);
    expect(budgets[1]).toMatchObject({ attemptsLeft: 1 });
    await tick();
    expect(state().status).toBe('verified');
  }, 90_000);

  it('still stops for a decision when an owner reports failed without a delivery report', async () => {
    const { tick, state, dispatches } = await setup(
      (attempt, commit) => commit({ 'feature.js': 'process.exit(0);' }, 'work'),
      { failed: () => true },
    );
    await tick();
    expect(dispatches).toEqual(['start']);
    expect(state().blocker).toMatchObject({
      note: expect.stringMatching(/reported failed on attempt 1 without a delivery report/),
    });
  }, 90_000);

  it('stops when an owner keeps reporting failed and the attempt budget is spent', async () => {
    const { tick, state, dispatches } = await setup(
      (attempt, commit, line) =>
        commit(
          {
            'feature.js': 'process.exit(0);',
            [soloReportPath(spec.id, attempt)]: `${line}
## Remaining
more
`,
          },
          `a${attempt}`,
        ),
      { failed: () => true },
    );
    for (let i = 0; i < 4; i++) await tick();
    expect(dispatches).toEqual(['start', 'resume', 'resume']);
    expect(state().status).toBe('blocked');
  }, 90_000);

  it('notifies the Human of an owner escalation once, answers with the standing rule, and acks the delivery', async () => {
    const message: OrcaMessage = {
      id: 'msg_1',
      type: 'escalation',
      subject: 'Conflicting oracle',
      body: 'An existing fixture contradicts AC-1.',
    };
    const { tick, state, replies, acked, dir } = await setup(
      (attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'),
      { inbox: [message] },
    );
    await tick();
    const opened = ProjectJournal.open(dir);
    const notices = opened.journal
      .events(spec.id)
      .filter(item => item.type === 'human-notified' && (item.data as { kind?: string }).kind === 'escalation');
    opened.close();
    expect(notices).toHaveLength(1);
    expect(notices[0].data).toMatchObject({ messageId: 'msg_1', subject: 'Conflicting oracle' });
    expect(replies).toEqual([{ messageId: 'msg_1', body: ESCALATION_REPLY }]);
    expect(acked).toEqual(['msg_1']);
    await tick();
    expect(replies).toHaveLength(1);
    expect(state().status).toBe('verified');
  }, 90_000);
});

describe('stalled Codex input', () => {
  it('reads the screen: presses Enter up to three times a minute apart while the brief is unsent, then tells the Human', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-stall-'));
    dirs.push(dir);
    const store = SqliteStore.open(join(dir, 'state.sqlite'));
    const t0 = Date.parse('2026-11-08T00:00:00.000Z');
    let n = 0;
    const add = (type: GoalEventType, data?: unknown) =>
      store.append({ id: `S-${++n}`, goalId: spec.id, type, data, at: new Date(t0).toISOString() });
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const ref: RuntimeRef = {
      runId: 'r',
      taskId: 't',
      dispatchId: 'ctx_1',
      owner: 'lead',
      repoPath: dir,
      terminal: 'term_1',
    };
    add('dispatch-intended', 'k');
    add('execution-started', ref);
    const nudges: string[] = [];
    const screen = ['› [Pasted Content 7848 chars]', '  GPT-6.1 Terra medium'];
    const runtime: RuntimeAdapter = {
      async startLead() {
        return ref;
      },
      async resumeSolo() {
        return ref;
      },
      async inspect() {
        return { state: 'live', ref };
      },
      async composerPending() {
        return composerHasUnsentBrief(screen);
      },
      async nudge(terminal) {
        nudges.push(terminal);
      },
    };
    let now = t0 + 30_000;
    const supervisor = new SoloSupervisor(store, runtime, { now: () => now });
    expect(await supervisor.step(spec.id, dir)).toEqual([]);
    now = t0 + 70_000;
    expect(await supervisor.step(spec.id, dir)).toEqual(['nudged ctx_1 (1/3)']);
    expect(await supervisor.step(spec.id, dir)).toEqual([]);
    now = t0 + 140_000;
    expect(await supervisor.step(spec.id, dir)).toEqual(['nudged ctx_1 (2/3)']);
    now = t0 + 210_000;
    expect(await supervisor.step(spec.id, dir)).toEqual(['nudged ctx_1 (3/3)']);
    now = t0 + 280_000;
    expect(await supervisor.step(spec.id, dir)).toEqual(['stalled ctx_1; Human notified']);
    expect(await supervisor.step(spec.id, dir)).toEqual([]);
    expect(nudges).toHaveLength(3);
    store.close();
  });

  it('reads the screen with the rules of the agent the owner was launched with', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-stall-agy-'));
    dirs.push(dir);
    const store = SqliteStore.open(join(dir, 'state.sqlite'));
    const t0 = Date.parse('2026-11-08T00:00:00.000Z');
    let n = 0;
    const add = (type: GoalEventType, data?: unknown) =>
      store.append({ id: `S-${++n}`, goalId: spec.id, type, data, at: new Date(t0).toISOString() });
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const ref: RuntimeRef = {
      runId: 'r',
      taskId: 't',
      dispatchId: 'ctx_1',
      owner: 'lead',
      repoPath: dir,
      terminal: 'term_1',
      requested: { agent: 'antigravity' },
    };
    add('dispatch-intended', 'k');
    add('execution-started', ref);
    const screen = readFileSync(
      join(fileURLToPath(new URL('../runtime/fixtures/screens/antigravity/unsent.txt', import.meta.url))),
      'utf8',
    ).split(/\r?\n/);
    const agents: (string | undefined)[] = [];
    const runtime: RuntimeAdapter = {
      async startLead() {
        return ref;
      },
      async resumeSolo() {
        return ref;
      },
      async inspect() {
        return { state: 'live', ref };
      },
      async composerPending(_terminal, agent) {
        agents.push(agent);
        return unsentBrief(agent, screen);
      },
      async nudge() {},
    };
    const supervisor = new SoloSupervisor(store, runtime, { now: () => t0 + 70_000 });
    expect(await supervisor.step(spec.id, dir)).toEqual(['nudged ctx_1 (1/3)']);
    expect(agents).toEqual(['antigravity']);
    store.close();
  });

  it('never reports an agent that is visibly working, whatever Orca says (seen live: false stalled notice)', () => {
    expect(composerHasUnsentBrief(['• Working (50s • esc to interrupt)', '› Ask Codex to do anything'])).toBe(false);
    expect(composerHasUnsentBrief(['› Ask Codex to do anything', '  GPT-6.1 Terra medium'])).toBe(false);
    expect(
      composerHasUnsentBrief([
        '› [Pasted Content 1285 chars]  orca orchestration send --from term --type worker_done --subject',
        '  "<short status[Pasted Content 2313 chars]',
      ]),
    ).toBe(true);
  });
});

describe('Orca refusing a resume', () => {
  it('drops a refused resume intent so the next try is a clean retry, but keeps an unknown outcome for recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-refuse-'));
    dirs.push(dir);
    const store = SqliteStore.open(join(dir, 'state.sqlite'));
    let n = 0;
    const add = (type: GoalEventType, data?: unknown) =>
      store.append({ id: `F-${++n}`, goalId: spec.id, type, data, at: '2026-11-08T00:00:00.000Z' });
    add('goal-drafted', spec);
    add('goal-approved', approval);
    add('goal-selected');
    add('proposal-drafted', proposal);
    add('proposal-approved');
    const ref: RuntimeRef = {
      runId: 'r',
      taskId: 't',
      dispatchId: 'ctx_1',
      owner: 'lead',
      repoPath: dir,
      terminal: 'term_1',
      worktreeId: 'repo::wt',
    };
    add('dispatch-intended', 'k');
    add('execution-started', ref);
    add('checkpointed', { phase: 'repair', progress: 'fix', evidenceRefs: [] });
    let mode: 'refuse' | 'unknown' | 'ok' = 'refuse';
    const runtime: RuntimeAdapter = {
      async startLead() {
        return ref;
      },
      async resumeSolo() {
        if (mode === 'refuse') throw new OrcaRefused('agent_unconfigured', 'agent_unconfigured');
        if (mode === 'unknown') throw new Error('state=outcome_unknown');
        return { ...ref, dispatchId: 'ctx_2' };
      },
      async inspect(r) {
        return { state: 'settled', outcome: 'completed', ref: r };
      },
      async recover() {
        return { ...ref, dispatchId: 'ctx_2' };
      },
    };
    const solo = new SoloService(store, runtime);
    await expect(solo.resume(spec.id)).rejects.toThrow(/agent_unconfigured/);
    expect(store.getGoal(spec.id)?.resumeIntent).toBeUndefined();
    mode = 'unknown';
    await expect(solo.resume(spec.id)).rejects.toThrow(/outcome_unknown/);
    expect(store.getGoal(spec.id)?.resumeIntent).toBeDefined();
    expect((await solo.resume(spec.id)).dispatchId).toBe('ctx_2');
    store.close();
  });
});
