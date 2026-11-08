import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { spec as baseSpec, proposal, sourceText } from '../domain/fixtures.test-support.js';
import type { GoalSpec } from '../domain/contracts.js';
import type { RuntimeAdapter, RuntimeRef } from '../runtime/orca.js';
import { CORE_SKILL, activationLine, committedFileDigest, reviewResultPath, soloReportPath } from '../runtime/brief.js';
import { ProjectJournal } from '../store/journal.js';
import { SqliteStore } from '../store/sqlite.js';
import { SoloSupervisor } from './supervisor.js';
import { approval } from '../domain/fixtures.test-support.js';
import type { GoalEventType } from '../domain/transitions.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
const spec: GoalSpec = { ...baseSpec, checks: [{ id: 'CHK-1', kind: 'command', command: 'node harness.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} }] };
const APPETITE = ['--size', 'M', '--max-spend', '20', '--max-minutes', '240', '--max-attempts', '3'];

/**
 * A fake Orca whose "owner" works directly in the repo checkout (its worktree). Each dispatch runs the
 * scripted work for that attempt, then settles. Everything else - gate, findings, resume, review,
 * verification, merge - is the real controller on real Git.
 */
async function setup(work: (attempt: number, commit: (files: Record<string, string>, message: string) => void, line: string) => void, options: { risks?: string[]; reviewer?: (commit: (files: Record<string, string>) => void, key: string) => void; launched?: string; intrude?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-auto-')); dirs.push(dir);
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-auto-art-')); dirs.push(artifacts);
  execFileSync('git', ['init', '-q', dir]);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'harness.js'), "require('./feature.js');");
  git('add', 'harness.js'); git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'harness');
  let owner = '';
  const commitIn = (cwd: string) => (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) { mkdirSync(join(cwd, name, '..'), { recursive: true }); writeFileSync(join(cwd, name), content); }
    execFileSync('git', ['-C', cwd, 'add', '--', ...Object.keys(files)]);
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Owner', '-c', 'user.email=o@local.invalid', 'commit', '-qm', message]);
  };
  const commit = (files: Record<string, string>, message: string) => commitIn(options.intrude ? dir : owner)(files, message);
  let attempt = 0;
  const dispatches: string[] = [];
  const settled = new Set<string>();
  const released: string[] = [];
  let reviewKey: string | undefined;
  const ref = (n: number): RuntimeRef => ({ runId: 'run_1', taskId: `task_${n}`, dispatchId: `ctx_${n}`, owner: 'lead', repoPath: dir, terminal: 'term_1', worktreeId: `repo::${owner}`, baseCommit: base, requested: { agent: 'codex', model: 'gpt-6.1-terra' } });
  let base = '';
  const runOwner = () => {
    attempt += 1;
    work(attempt, commit, activationLine(committedFileDigest(dir, base, CORE_SKILL)));
    settled.add(`ctx_${attempt}`);
  };
  const runtime: RuntimeAdapter = {
    async startSolo() {
      base = git('rev-parse', 'HEAD'); dispatches.push('start');
      owner = join(mkdtempSync(join(tmpdir(), 'apos-auto-wt-')), 'wt'); dirs.push(join(owner, '..'));
      git('worktree', 'add', '-q', '-b', 'owner', owner, base);
      const r = ref(1); runOwner(); return r;
    },
    async resumeSolo() { dispatches.push('resume'); const r = ref(attempt + 1); runOwner(); return r; },
    async inspect(r) { return settled.has(r.dispatchId) ? { state: 'settled', outcome: 'completed', ref: r } : { state: 'live', ref: r }; },
    async deliveryHead(r) { return execFileSync('git', ['-C', r.worktreeId ? r.worktreeId.split('::')[1] : owner, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); },
    async launchReceipt() { return { agent: 'codex', model: options.launched ?? 'gpt-6.1-terra' }; },
    async startReviewer(input) {
      reviewKey = input.idempotencyKey;
      const reviewWt = join(mkdtempSync(join(tmpdir(), 'apos-auto-rv-')), 'wt'); dirs.push(join(reviewWt, '..'));
      git('worktree', 'add', '-q', '--detach', reviewWt, input.commit);
      options.reviewer?.(files => commitIn(reviewWt)(files, 'review'), input.idempotencyKey);
      settled.add('ctx_review');
      return { runId: 'run_1', taskId: 'task_r', dispatchId: 'ctx_review', owner: 'reviewer', repoPath: dir, worktreeId: `repo::${reviewWt}`, key: input.idempotencyKey, commit: input.commit };
    },
    async releaseWorker(dispatchId) { released.push(dispatchId); }
  };
  const output: string[] = [];
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { runtime, gate: { artifactRoot: artifacts }, write: line => output.push(line) });
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ ...proposal, risks: options.risks ?? [] }));
  writeFileSync(join(dir, '.git', 'info', 'exclude'), 'goal.json\nbrief.md\nplan.json\n');
  await invoke('init');
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  await invoke('goal', 'approve', spec.id, ...APPETITE);
  await invoke('goal', 'select', spec.id);
  await invoke('lead', 'propose', '--file', join(dir, 'plan.json'));
  await invoke('lead', 'commit', spec.id);
  const tick = async () => { await invoke('controller', 'tick'); return output.at(-1)!; };
  const state = () => { const opened = ProjectJournal.open(dir); try { return opened.journal.getGoal(spec.id)!; } finally { opened.close(); } };
  return { dir, git, invoke, tick, state, dispatches, released, output, reviewKeyOf: () => reviewKey };
}

const report = (attempt: number, line: string) => ({ [soloReportPath(spec.id, attempt)]: `# Delivery\n\n${line}\nreviewedHead: HEAD\n` });

describe('Solo autopilot', () => {
  it('turns a red gate into a machine finding, resumes the same owner, then verifies the fix', async () => {
    const { tick, state, dispatches, invoke, git, released } = await setup((attempt, commit, line) => {
      commit({ 'feature.js': attempt === 1 ? 'process.exit(1);' : 'process.exit(0);', ...report(attempt, line) }, `attempt ${attempt}`);
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
    const { tick, state, dispatches } = await setup((attempt, commit, line) => commit({ 'feature.js': 'process.exit(1);', ...report(attempt, line) }, `attempt ${attempt}`));
    for (let i = 0; i < 4; i++) await tick();
    expect(dispatches).toEqual(['start', 'resume', 'resume']);
    expect(state()).toMatchObject({ status: 'blocked', blocker: { note: expect.stringMatching(/needs-decision: same failure after two repairs/) } });
  }, 90_000);

  it('does not accept a delivery whose report lacks the core activation line', async () => {
    const { tick, state, dispatches } = await setup((attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, attempt === 1 ? 'no activation' : line) }, `attempt ${attempt}`));
    await tick(); await tick(); await tick();
    expect(dispatches).toEqual(['start', 'resume']);
    expect(state().findings![0].note).toMatch(/activation line/);
    expect(state().status).toBe('verified');
  }, 90_000);

  it('stops for a decision when the runtime launched a different model than planned', async () => {
    const { tick, state } = await setup((attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'), { launched: 'gpt-6-luna' });
    await tick(); await tick();
    expect(state().blocker).toMatchObject({ note: expect.stringMatching(/launched codex\/gpt-6-luna, plan requires codex\/gpt-6.1-terra/) });
  }, 90_000);

  it('sends a risky green delivery to a separate reviewer session and verifies only on its pass', async () => {
    const { tick, state } = await setup((attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work'), {
      risks: ['auth regression'],
      reviewer: (commit, key) => commit({ [reviewResultPath(spec.id, key)]: JSON.stringify({ result: 'pass', note: 'Checked auth paths and boundaries' }) })
    });
    // lead commit dispatched the owner; the first tick gates its delivery green and starts the reviewer.
    expect(await tick()).toContain('reviewer ctx_review');
    expect(state()).toMatchObject({ status: 'executing', reviewDispatch: { dispatchId: 'ctx_review' } });
    expect(await tick()).toContain('review pass');
    expect(state().reviews[0]).toMatchObject({ reviewer: 'apos-reviewer', session: 'ctx_review', result: 'pass' });
    expect(state().status).toBe('verified');
  }, 90_000);

  it('turns a reviewer request for changes into a finding for the same owner', async () => {
    let reviews = 0;
    const { tick, state, dispatches } = await setup((attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, `attempt ${attempt}`), {
      risks: ['auth regression'],
      reviewer: (commit, key) => { reviews += 1; commit({ [reviewResultPath(spec.id, key)]: JSON.stringify(reviews === 1 ? { result: 'changes', note: 'src/auth.ts: expired token still accepted' } : { result: 'pass', note: 'Fixed' }) }); }
    });
    await tick(); await tick();
    expect(dispatches).toEqual(['start', 'resume']);
    expect(state().findings![0].note).toMatch(/expired token still accepted/);
    await tick(); await tick();
    expect(state().status).toBe('verified');
  }, 90_000);

  it('stops for a decision when the owner commits into the managed checkout instead of its worktree', async () => {
    const { tick, state } = await setup((attempt, commit, line) => commit({ 'feature.js': 'process.exit(0);', ...report(attempt, line) }, 'work in the wrong place'), { intrude: true });
    await tick();
    expect(state().blocker).toMatchObject({ note: expect.stringMatching(/needs-decision: commits by someone other than APOS landed in the managed checkout/) });
  }, 90_000);
});

describe('stalled Codex input', () => {
  it('presses Enter once after a few quiet minutes, then asks the Human if the owner still never started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-stall-')); dirs.push(dir);
    const store = SqliteStore.open(join(dir, 'state.sqlite'));
    const t0 = Date.parse('2026-11-08T00:00:00.000Z');
    let n = 0;
    const add = (type: GoalEventType, data?: unknown) => store.append({ id: `S-${++n}`, goalId: spec.id, type, data, at: new Date(t0).toISOString() });
    add('goal-drafted', spec); add('goal-approved', approval); add('goal-selected'); add('proposal-drafted', proposal); add('proposal-approved');
    const ref: RuntimeRef = { runId: 'r', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir, terminal: 'term_1' };
    add('dispatch-intended', 'k'); add('execution-started', ref);
    const nudges: string[] = [];
    const runtime: RuntimeAdapter = { async startSolo() { return ref; }, async resumeSolo() { return ref; }, async inspect() { return { state: 'live', ref }; }, async inputStalled() { return true; }, async nudge(terminal) { nudges.push(terminal); } };
    let now = t0 + 2 * 60_000;
    const supervisor = new SoloSupervisor(store, runtime, { now: () => now });
    expect(await supervisor.step(spec.id, dir)).toEqual([]);
    now = t0 + 5 * 60_000;
    expect(await supervisor.step(spec.id, dir)).toEqual(['nudged ctx_1']);
    expect(await supervisor.step(spec.id, dir)).toEqual([]);
    now = t0 + 11 * 60_000;
    expect(await supervisor.step(spec.id, dir)).toEqual(['stalled ctx_1; Human notified']);
    expect(nudges).toEqual(['term_1']);
    store.close();
  });
});

