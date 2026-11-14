import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrcaRuntime } from './runtime/orca.js';
import { DEFAULT_PROFILES } from './runtime/brief.js';
import { runCli } from './cli.js';
import { spec as baseSpec, proposal, sourceText } from './domain/fixtures.test-support.js';
import type { GoalSpec } from './domain/contracts.js';
import type { RuntimeAdapter, RuntimeRef } from './runtime/orca.js';
import { ProjectJournal } from './store/journal.js';

/**
 * FINAL-DESIGN §8 safety cases not already covered next to the code they test. The full map from
 * each case to its test lives in docs/fault-injection.md.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

describe('brief with $ and quotes', () => {
  it('reaches Orca as one argument, byte for byte, with no shell in between', async () => {
    const calls: string[][] = [];
    const runtime = new OrcaRuntime(args => {
      calls.push(args);
      if (args[1] === 'run-list') return { runs: [] };
      if (args[1] === 'run-create') return { run: { id: 'run_1' } };
      return { runId: 'run_1', taskId: 't', dispatchId: 'd', effects: [] };
    }, () => 'a'.repeat(40), DEFAULT_PROFILES, () => 'd'.repeat(64));
    const outcome = `pay $HOME "quoted" 'single' \`tick\` $(rm -rf /) %PATH%`;
    await runtime.startPackage({ repoPath: 'C:/p', idempotencyKey: 'k-1', package: { id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 1, owner: 'w', outcome, scope: ['s'], exclusions: [], dependencies: [], interfaces: ['x@v1'], acceptance: [{ id: 'AC-1', text: 't' }], integration: 'i' } });
    const start = calls.find(args => args[1] === 'worker-start')!;
    const spec = start[start.indexOf('--spec') + 1];
    expect(spec).toContain(`deliver ${outcome}.`);
    expect(spec).not.toMatch(/\n/);
  });
});

describe('target branch head moved after verification', () => {
  it('merges the gated commit, reruns the gate on the merge, and keeps the Goal open when that gate is red', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-fault-')); dirs.push(dir);
    const artifacts = mkdtempSync(join(tmpdir(), 'apos-fault-art-')); dirs.push(artifacts);
    execFileSync('git', ['init', '-q', dir]);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    const spec: GoalSpec = { ...baseSpec, checks: [{ id: 'CHK-1', kind: 'command', command: 'node harness.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} }] };
    const ref: RuntimeRef = { runId: 'r', taskId: 't', dispatchId: 'ctx_1', owner: 'lead', repoPath: dir, terminal: 'term_lead', worktreeId: 'repo::C:/lead-wt' };
    const runtime: RuntimeAdapter = { async startLead() { ref.baseCommit = git('rev-parse', 'HEAD'); return ref; }, async resumeSolo() { return ref; }, async inspect() { return { state: 'settled', outcome: 'completed', ref }; } };
    const output: string[] = [];
    const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { runtime, gate: { artifactRoot: artifacts }, write: line => output.push(line) });
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.json\nbrief.md\n');
    writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec)); writeFileSync(join(dir, 'brief.md'), sourceText); writeFileSync(join(dir, 'plan.json'), JSON.stringify(proposal));
    writeFileSync(join(dir, 'harness.js'), "require('./feature.js'); process.exit(require('fs').existsSync('legacy.flag') ? 1 : 0);");
    git('add', 'harness.js'); git('-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-qm', 'harness');
    await invoke('init');
    const target = git('branch', '--show-current');
    await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
    await invoke('goal', 'approve', spec.id, '--size', 'S', '--max-spend', '5', '--max-minutes', '60', '--max-attempts', '2');
    await invoke('goal', 'select', spec.id);
    process.env.ORCA_TERMINAL_HANDLE = 'term_lead';
    try {
      await invoke('lead', 'propose', '--file', join(dir, 'plan.json'));
      await invoke('lead', 'commit', spec.id);
    } finally { delete process.env.ORCA_TERMINAL_HANDLE; }
    git('switch', '-q', '-c', 'owner', ref.baseCommit!); // the Lead's branch, cut from its base at selection
    writeFileSync(join(dir, 'feature.js'), 'module.exports = 1;');
    git('add', 'feature.js'); git('-c', 'user.name=O', '-c', 'user.email=o@x.invalid', 'commit', '-qm', 'owner work');
    const delivery = git('rev-parse', 'HEAD');
    await invoke('gate', 'run', spec.id, '--commit', delivery);
    await invoke('execution', 'verify', spec.id, '--commit', delivery);
    // Someone moves the target branch after verification, in a way that breaks the Goal's check.
    git('switch', '-q', target);
    writeFileSync(join(dir, 'legacy.flag'), 'x'); git('add', 'legacy.flag'); git('-c', 'user.name=S', '-c', 'user.email=s@x.invalid', 'commit', '-qm', 'unrelated change');
    await expect(invoke('outcome', 'close', spec.id, '--merge-to', target)).rejects.toThrow(/Post-merge gate is red/);
    const opened = ProjectJournal.open(dir);
    const state = opened.journal.getGoal(spec.id)!;
    opened.close();
    expect(state).toMatchObject({ status: 'verified', postMergeGate: { result: 'red' } });
    expect(state.merge?.sourceRef).toBe(delivery);
  }, 90_000);
});
