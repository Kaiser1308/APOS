import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { controllerHome } from './store/event-log.js';
import { spec as baseSpec, proposal, sourceText, approval } from './domain/fixtures.test-support.js';
import type { GoalSpec } from './domain/contracts.js';

// The gate really runs this in a fresh worktree at the commit under test.
const spec: GoalSpec = {
  ...baseSpec,
  checks: [
    { id: 'CHK-1', kind: 'command', command: 'node harness.js', expect: 'pass', runs: 1, timeoutMs: 60_000, env: {} },
  ],
};
const commitAll = (git: (args: string[]) => string, message: string) => {
  git(['add', '-A', '--', '.', ':!*.json', ':!brief.md']);
  git(['-c', 'user.name=Owner', '-c', 'user.email=owner@local.invalid', 'commit', '-qm', message]);
  return git(['rev-parse', 'HEAD']);
};
import type { WorkPackageSpec } from './domain/packages.js';
import type { PackageRuntime, RuntimeAdapter } from './ports/runtime.js';
import type { RuntimeRef } from './domain/runtime-refs.js';

const dirs: string[] = [];
/** Runs `fn` as the Lead Orca dispatched: its terminal handle is the one APOS recorded. */
async function asLead<T>(terminal: string, fn: () => Promise<T>): Promise<T> {
  process.env.ORCA_TERMINAL_HANDLE = terminal;
  try {
    return await fn();
  } finally {
    delete process.env.ORCA_TERMINAL_HANDLE;
  }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

it('dispatches a Solo plan the Lead commits after Human Goal approval and selection, with no Human plan gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-cli-art-'));
  dirs.push(artifacts);
  const goalFile = join(dir, 'goal-input.json');
  const proposalFile = join(dir, 'proposal-input.json');
  const sourceFile = join(dir, 'brief.md');
  writeFileSync(goalFile, JSON.stringify(spec));
  writeFileSync(sourceFile, sourceText);
  writeFileSync(proposalFile, JSON.stringify(proposal));
  writeFileSync(join(dir, 'harness.js'), "require('./feature.js');");
  git(['add', 'harness.js']);
  git(['-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'harness']);
  let starts = 0;
  let soloDone = false;
  const released: string[] = [];
  const ref: RuntimeRef = {
    runId: 'run_1',
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    owner: 'lead',
    repoPath: dir,
    terminal: 'term_lead',
    worktreeId: 'repo::C:/lead-wt',
  };
  const runtime: RuntimeAdapter = {
    async startLead() {
      starts++;
      ref.baseCommit = git(['rev-parse', 'HEAD']);
      return ref;
    },
    async resumeSolo() {
      return ref;
    },
    async inspect() {
      return soloDone ? { state: 'settled', outcome: 'completed', ref } : { state: 'live', ref };
    },
    async releaseWorker(dispatchId) {
      released.push(dispatchId);
    },
  };
  const output: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { runtime, gate: { artifactRoot: artifacts }, write: line => output.push(line) });
  await invoke('init');
  await invoke('goal', 'create', '--file', goalFile, '--source', sourceFile);
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
  await invoke('lead', 'recommend');
  expect(starts).toBe(0);
  expect(output.join('\n')).toContain(spec.id);
  await invoke('goal', 'select', spec.id);
  expect(starts).toBe(1); // selecting the Goal dispatches its Lead
  await expect(invoke('lead', 'propose', '--file', proposalFile)).rejects.toThrow(/Lead terminal APOS dispatched/);
  await asLead('term_lead', async () => {
    await invoke('lead', 'propose', '--file', proposalFile);
    await invoke('lead', 'commit', spec.id);
  });
  expect(starts).toBe(1); // the Solo owner is that Lead: no second session
  expect(output.at(-1)).toMatch(/you \(Lead ctx_1\) are the Solo owner/);
  await invoke('execution', 'status', spec.id);
  expect(output.at(-1)).toContain('executing');
  await invoke('execution', 'reconcile', spec.id);
  expect(output.at(-1)).toContain('live');
  await invoke('decision', 'record', spec.id, '--note', 'Use existing auth flow');
  await invoke('blocker', 'report', spec.id, '--kind', 'external', '--note', 'Test service unavailable');
  await invoke('blocker', 'resolve', spec.id, '--note', 'Test service restored');
  const evidenceFile = join(dir, 'evidence-input.json');
  writeFileSync(
    evidenceFile,
    JSON.stringify({ acceptanceId: 'AC-1', result: 'pass', command: 'npm test', artifactRef: 'commit:abc' }),
  );
  await invoke('evidence', 'add', spec.id, '--file', evidenceFile);
  soloDone = true;
  // The owner (the Lead) works on its own branch, cut from its base at selection; APOS milestone commits stay on main.
  const target = git(['branch', '--show-current']);
  git(['switch', '-q', '-c', 'lead-wt', ref.baseCommit!]);
  // The owner claims pass but has not delivered the code: the controller's own run is red.
  writeFileSync(join(dir, 'feature.js'), 'process.exit(1);');
  const broken = commitAll(git, 'owner: broken');
  await invoke('gate', 'run', spec.id, '--commit', broken);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ result: 'red' });
  await expect(invoke('execution', 'verify', spec.id)).rejects.toThrow(/gate is red/);
  writeFileSync(join(dir, 'feature.js'), 'process.exit(0);');
  const fixed = commitAll(git, 'owner: fixed');
  await invoke('gate', 'run', spec.id, '--commit', fixed);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ result: 'green', deliveryCommit: fixed });
  await expect(invoke('execution', 'verify', spec.id, '--commit', broken)).rejects.toThrow(/not [0-9a-f]{40}/);
  await invoke('execution', 'verify', spec.id, '--commit', fixed);
  git(['switch', '-q', target]);
  await invoke('outcome', 'close', spec.id, '--merge-to', target);
  expect(output.find(line => line.startsWith('Merged'))).toMatch(/post-merge gate green/);
  expect(released).toEqual([]); // no settlement was recorded on this manual path; see the autopilot test
  await invoke('execution', 'status', spec.id);
  expect(output.at(-1)).toContain('closed');
}, 60_000); // real gates and merges in Git; seen at 30.2 s under a parallel full-suite run on Windows

it('runs an approved two-package Goal through dependency release, integration and Human closure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-multi-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const input = (name: string, data: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(data));
    return path;
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
  const starts: string[] = [];
  const runtime: RuntimeAdapter & PackageRuntime = {
    async startLead({ repoPath }) {
      return {
        runId: 'run_lead',
        taskId: 'lead',
        dispatchId: 'lead-1',
        owner: 'lead',
        repoPath,
        terminal: 'term_lead',
        worktreeId: 'repo::C:/lead-wt',
        baseCommit: git(['rev-parse', 'HEAD']),
      };
    },
    async resumeSolo() {
      throw new Error('Solo must not resume');
    },
    async inspect(ref) {
      return { state: 'settled', ref };
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
        baseCommit: git(['rev-parse', 'HEAD']),
      };
    },
  };
  const output: string[] = [];
  const artifacts = mkdtempSync(join(tmpdir(), 'apos-cli-art-'));
  dirs.push(artifacts);
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { runtime, gate: { artifactRoot: artifacts }, write: line => output.push(line) });
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'harness.js'), "require('./feature.js');");
  git(['add', 'harness.js']);
  git(['-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'harness']);
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
  await asLead('term_lead', async () => {
    await invoke('lead', 'propose', '--file', input('proposal.json', { ...proposal, mode: 'multi-wp' }));
    await invoke('package', 'add', '--file', input('wp-a.json', a));
    await invoke('package', 'add', '--file', input('wp-b.json', b));
    expect(starts).toEqual([]);
    await invoke('lead', 'commit', spec.id);
  });
  expect(starts).toEqual(['WP-01']);
  expect(output.find(line => line.startsWith('NOTICE'))).toMatch(/Multi-WP \(2 packages/);
  writeFileSync(join(dir, 'scanner.ts'), 'export const scan = true;');
  git(['add', 'scanner.ts']);
  git(['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '-qm', 'scanner']);
  const commitA = git(['rev-parse', 'HEAD']);
  await invoke(
    'package',
    'evidence',
    spec.id,
    '--file',
    input('evidence-a.json', {
      packageId: a.id,
      packageVersion: 1,
      owner: a.owner,
      acceptanceId: 'WP-AC-1',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:a',
      commitRef: commitA,
    }),
  );
  await invoke('package', 'verify', spec.id, a.id);
  await invoke('package', 'ready', spec.id);
  expect(output.at(-1)).toBe('[]');
  expect(starts).toEqual(['WP-01', 'WP-02']);
  writeFileSync(join(dir, 'history.ts'), 'export const history = true;');
  writeFileSync(join(dir, 'feature.js'), 'process.exit(0);');
  git(['add', 'history.ts', 'feature.js']);
  git(['-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '-qm', 'history']);
  const commitB = git(['rev-parse', 'HEAD']);
  await invoke(
    'package',
    'evidence',
    spec.id,
    '--file',
    input('evidence-b.json', {
      packageId: b.id,
      packageVersion: 1,
      owner: b.owner,
      acceptanceId: 'WP-AC-2',
      result: 'pass',
      command: 'npm test',
      artifactRef: 'log:b',
      commitRef: commitB,
    }),
  );
  await invoke('package', 'verify', spec.id, b.id);
  await invoke('integration', 'prepare', spec.id);
  expect(output.at(-1)).toContain(commitA);
  const integrationCommit = git(['rev-parse', 'HEAD']);
  await invoke('gate', 'run', spec.id, '--commit', integrationCommit);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ result: 'green' });
  await invoke(
    'review',
    'submit',
    spec.id,
    '--file',
    input('review.json', {
      subject: 'goal',
      reviewer: 'reviewer-agent',
      session: 'review-1',
      result: 'pass',
      commitRef: integrationCommit,
      note: 'Checked integrated flow',
    }),
  );
  await invoke(
    'integration',
    'complete',
    spec.id,
    '--file',
    input('integration.json', {
      commitRef: integrationCommit,
      acceptance: [{ acceptanceId: 'AC-1', result: 'pass', command: 'npm test', artifactRef: 'log:goal' }],
      regression: { result: 'pass', command: 'npm test', artifactRef: 'log:regression' },
    }),
  );
  await invoke('outcome', 'close', spec.id);
  await invoke('execution', 'status', spec.id);
  expect(output.at(-1)).toContain('closed');
}, 30_000);

it('refuses approval when the source snapshot was edited after drafting, or a requirement is unmapped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-src-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const output: string[] = [];
  const runtime: RuntimeAdapter = {
    async startLead() {
      throw new Error('no dispatch');
    },
    async resumeSolo() {
      throw new Error('no resume');
    },
    async inspect(ref) {
      return { state: 'live', ref };
    },
  };
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { runtime, write: line => output.push(line) });
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
  await invoke('init');
  writeFileSync(join(dir, 'tampered.md'), sourceText + 'Also accept expired codes.\n');
  await expect(
    invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'tampered.md')),
  ).rejects.toThrow(/sha256 does not match/);
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  writeFileSync(join(controllerHome(dir), 'sources', spec.id, 'v1.md'), sourceText + 'Also accept expired codes.\n');
  await expect(
    invoke(
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
    ),
  ).rejects.toThrow(/Source snapshot .* differs/);

  const orphan = {
    ...spec,
    id: 'GOAL-002',
    requirements: [
      ...spec.requirements,
      { id: 'R-2', sourceSpan: 'line 3', text: 'exactly one', disposition: 'acceptance' },
    ],
  };
  writeFileSync(join(dir, 'goal2.json'), JSON.stringify(orphan));
  await invoke('goal', 'create', '--file', join(dir, 'goal2.json'), '--source', join(dir, 'brief.md'));
  await expect(
    invoke(
      'goal',
      'approve',
      'GOAL-002',
      '--size',
      'M',
      '--max-spend',
      '20',
      '--max-minutes',
      '240',
      '--max-attempts',
      '3',
    ),
  ).rejects.toThrow(/R-2 has no acceptance/);
}, 30_000);

it('refuses Human-only commands from an APOS agent terminal, so an owner cannot merge or approve for itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-human-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const ref: RuntimeRef = {
    runId: 'r',
    taskId: 't',
    dispatchId: 'ctx_1',
    owner: 'lead',
    repoPath: dir,
    terminal: 'term_owner',
    worktreeId: 'repo::C:/lead-wt',
  };
  const runtime: RuntimeAdapter = {
    async startLead() {
      ref.baseCommit = git(['rev-parse', 'HEAD']);
      return ref;
    },
    async resumeSolo() {
      return ref;
    },
    async inspect() {
      return { state: 'live', ref };
    },
  };
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { runtime, write: () => undefined });
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(spec));
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(proposal));
  await invoke('init');
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  await invoke(
    'goal',
    'approve',
    spec.id,
    '--size',
    'S',
    '--max-spend',
    '5',
    '--max-minutes',
    '60',
    '--max-attempts',
    '2',
  );
  await invoke('goal', 'select', spec.id);
  // The Lead is an agent from its dispatch on: before it commits any plan it already cannot act as the Human.
  await asLead('term_owner', async () => {
    await expect(
      invoke(
        'goal',
        'appetite',
        spec.id,
        '--size',
        'L',
        '--max-spend',
        '99',
        '--max-minutes',
        '999',
        '--max-attempts',
        '9',
        '--reason',
        'more',
      ),
    ).rejects.toThrow(/Human decision/);
    await expect(invoke('lead', 'start', spec.id)).rejects.toThrow(/Human decision/);
    await expect(invoke('lead', 'wake', spec.id, '--note', 'go')).rejects.toThrow(/Human decision/);
    await invoke('lead', 'propose', '--file', join(dir, 'plan.json'));
    await invoke('lead', 'commit', spec.id);
  });
  process.env.ORCA_TERMINAL_HANDLE = 'term_owner';
  try {
    await expect(invoke('outcome', 'close', spec.id, '--merge-to', 'main')).rejects.toThrow(/Human decision/);
    await expect(
      invoke(
        'goal',
        'appetite',
        spec.id,
        '--size',
        'L',
        '--max-spend',
        '99',
        '--max-minutes',
        '999',
        '--max-attempts',
        '9',
        '--reason',
        'more',
      ),
    ).rejects.toThrow(/Human decision/);
    await expect(invoke('blocker', 'resolve', spec.id, '--note', 'fine')).rejects.toThrow(/Human decision/);
  } finally {
    delete process.env.ORCA_TERMINAL_HANDLE;
  }
}, 30_000);

it('apos profile shows, sets and resets role profiles, and only the Human may change them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-prof-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-cli-prof-home-'));
  dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  const ref: RuntimeRef = {
    runId: 'run_1',
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    owner: 'lead',
    repoPath: dir,
    terminal: 'term_lead',
    worktreeId: 'repo::C:/lead-wt',
  };
  const runtime: RuntimeAdapter = {
    async startLead() {
      ref.baseCommit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      return ref;
    },
    async resumeSolo() {
      return ref;
    },
    async inspect() {
      return { state: 'live', ref };
    },
  };
  const output: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { runtime, home, write: line => output.push(line) });
  await invoke('init');
  await invoke('profile', 'set', 'all', '--agent', 'claude');
  output.length = 0;
  await invoke('profile', 'show');
  expect(output).toEqual([
    'lead: claude (runtime.json)',
    'worker: claude (runtime.json)',
    'reviewer: claude (runtime.json)',
  ]);
  output.length = 0;
  await invoke('profile', 'set', 'lead', '--agent', 'foo');
  expect(output.join('\n')).toMatch(/not a known agent/);
  await invoke('profile', 'reset');
  output.length = 0;
  await invoke('profile', 'show');
  expect(output[0]).toBe('lead: codex model=gpt-6.1-terra (default)');
  writeFileSync(join(dir, 'goal-input.json'), JSON.stringify(spec));
  writeFileSync(join(dir, 'brief.md'), sourceText);
  await invoke('goal', 'create', '--file', join(dir, 'goal-input.json'), '--source', join(dir, 'brief.md'));
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
  await asLead('term_lead', async () => {
    await expect(invoke('profile', 'set', 'worker', '--agent', 'claude')).rejects.toThrow(/Human decision/);
    await expect(invoke('profile', 'reset')).rejects.toThrow(/Human decision/);
  });
});

it('apos handoff moves the Lead to a fresh agent and, with --agent, changes only that role profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-cli-handoff-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-cli-handoff-home-'));
  dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  const ref: RuntimeRef = {
    runId: 'run_1',
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    owner: 'lead',
    repoPath: dir,
    terminal: 'term_lead',
    worktreeId: 'repo::C:/lead-wt',
  };
  const stops: string[] = [];
  const runtime: RuntimeAdapter = {
    async startLead() {
      ref.baseCommit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      return ref;
    },
    async resumeSolo() {
      return ref;
    },
    async inspect(r) {
      return { state: 'live', ref: r };
    },
    async stopWorker(dispatchId) {
      stops.push(dispatchId);
      return 'stopped';
    },
    async handoff(input) {
      return {
        runId: input.runId,
        taskId: 'task_2',
        dispatchId: 'ctx_2',
        owner: 'lead',
        repoPath: dir,
        terminal: 'term_2',
        worktreeId: input.worktreeId,
        baseCommit: input.baseCommit,
        requested: { agent: 'claude' },
      };
    },
  };
  const output: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], { runtime, home, write: line => output.push(line) });
  await invoke('init');
  writeFileSync(join(dir, 'goal-input.json'), JSON.stringify(spec));
  writeFileSync(join(dir, 'brief.md'), sourceText);
  await invoke('goal', 'create', '--file', join(dir, 'goal-input.json'), '--source', join(dir, 'brief.md'));
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
  await asLead('term_lead', async () => {
    await expect(invoke('handoff', spec.id, '--agent', 'claude')).rejects.toThrow(/Human decision/);
  });
  await invoke('handoff', spec.id, '--agent', 'claude');
  expect(stops).toEqual(['ctx_1']);
  expect(output.at(-1)).toBe(`handed off ${spec.id} to claude (ctx_2)`);
  const { loadProfiles } = await import('./runtime/brief.js');
  expect(loadProfiles(home).lead).toEqual({ agent: 'claude' });
  expect(loadProfiles(home).worker.agent).toBe('codex');
  // A package handoff changes the worker profile only, even when there is no such package to hand off.
  await expect(invoke('handoff', spec.id, '--package', 'WP-X', '--agent', 'antigravity')).rejects.toThrow(
    /no package WP-X/,
  );
  expect(loadProfiles(home).worker).toEqual({ agent: 'antigravity' });
  expect(loadProfiles(home).lead).toEqual({ agent: 'claude' });
});
