import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../app/init-project.js';
import { ProjectJournal } from '../store/journal.js';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import { approval, proposal, sourceText, spec } from '../domain/fixtures.test-support.js';
import { attemptKey } from '../domain/gate.js';
import type { GoalEventType } from '../domain/transitions.js';
import { readActivity, redact } from './activity.js';
import { buildStory } from './story.js';
import { route } from './server.js';

vi.setConfig({ testTimeout: 60_000 });
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function hashTree(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(path.slice(root.length)).update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest('hex');
}

const wt = (dir: string) => join(dir, 'wt');
const row = (value: unknown) => `${JSON.stringify(value)}\n`;

function transcripts(worktree: string, base: number) {
  const root = mkdtempSync(join(tmpdir(), 'apos-ui-tr-'));
  dirs.push(root);
  const iso = (seconds: number) => new Date(base + seconds * 1000).toISOString();
  const day = new Date(base);
  const codexDir = join(
    root,
    'codex',
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  );
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, 'rollout-a.jsonl'),
    row({ timestamp: iso(0), type: 'session_meta', payload: { cwd: worktree } }) +
      row({
        timestamp: iso(1),
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'SYSTEM PROMPT' }] },
      }) +
      row({
        timestamp: iso(2),
        type: 'response_item',
        payload: { type: 'reasoning', summary: [], encrypted_content: 'zzz' },
      }) +
      row({
        timestamp: iso(3),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Chose cookie sessions. <img src=x onerror=alert(1)> key sk-abcdefghijklmnopqrstuv',
            },
          ],
        },
      }) +
      row({
        timestamp: iso(4),
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'exec', input: 'npm test' },
      }) +
      row({
        timestamp: iso(5),
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          output: [{ type: 'input_text', text: 'Process exited with code 1\nFAIL login' }],
        },
      }) +
      row({
        timestamp: iso(7200),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'a much later session' }],
        },
      }) +
      `{"timestamp":"${iso(7)}","type":"response_item","payload":{"type":"mess`,
  ); // still being written, no newline
  const claudeDir = join(root, 'claude', worktree.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, 's.jsonl'),
    row({ type: 'user', timestamp: iso(1), cwd: worktree, message: { role: 'user', content: 'the brief' } }) +
      row({
        type: 'assistant',
        timestamp: iso(2),
        cwd: worktree,
        message: {
          content: [
            { type: 'thinking', thinking: '', signature: 's' },
            { type: 'text', text: 'Splitting into two files.' },
          ],
        },
      }) +
      row({
        type: 'assistant',
        timestamp: iso(3),
        cwd: worktree,
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: { todos: [{ content: 'write route', status: 'in_progress' }] },
            },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'API_KEY=hunter2hunter2 npm test' } },
          ],
        },
      }) +
      row({
        type: 'user',
        timestamp: iso(4),
        cwd: worktree,
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }] },
      }),
  );
  // A session in a folder of the same name that really ran elsewhere must not match.
  writeFileSync(
    join(claudeDir, 'other.jsonl'),
    row({
      type: 'assistant',
      timestamp: iso(2),
      cwd: join(worktree, 'elsewhere'),
      message: { content: [{ type: 'text', text: 'wrong place' }] },
    }),
  );
  return { root, roots: { codex: join(root, 'codex'), claude: join(root, 'claude') } };
}

async function dispatched(worktreeId: (dir: string) => string | undefined = dir => `repo::${wt(dir)}`) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-ui-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-ui-home-'));
  dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  const opened = ProjectJournal.open(dir, home);
  let n = 0;
  const add = (type: GoalEventType, data?: unknown) =>
    opened.journal.append({ id: `EV-${++n}`, goalId: 'GOAL-W', type, data, at: new Date().toISOString() });
  opened.journal.appendWithSource(
    {
      id: `EV-${++n}`,
      goalId: 'GOAL-W',
      type: 'goal-drafted',
      data: { ...spec, id: 'GOAL-W' },
      at: new Date().toISOString(),
    },
    sourceText,
  );
  add('goal-approved', approval);
  add('goal-selected');
  add('proposal-drafted', { ...proposal, goalId: 'GOAL-W' });
  add('proposal-approved');
  add('execution-started', {
    runId: 'run_1',
    taskId: 't',
    dispatchId: 'disp-w',
    owner: 'lead',
    repoPath: dir,
    worktreeId: worktreeId(dir),
  });
  opened.close();
  const events = new ReadOnlyJournal(home).events('GOAL-W');
  return { dir, home, events, startedAt: Date.parse(events.find(item => item.type === 'execution-started')!.at) };
}

it('reads Codex and Claude Code transcripts into one readable activity, without reasoning, prompts or secrets', async () => {
  const d = await dispatched();
  const t = transcripts(wt(d.dir), d.startedAt);
  const reply = readActivity(d.events, 'disp-w', undefined, t.roots)!;
  expect(reply.found).toBe(true);
  expect(reply.matched.map(item => item.agent).sort()).toEqual(['claude', 'codex']);
  const text = reply.items.map(item => `${item.kind}:${item.text}`).join('\n');
  expect(text).toContain('say:Chose cookie sessions.');
  expect(text).toContain('say:Splitting into two files.');
  expect(text).toContain('plan:[in_progress] write route');
  expect(text).toContain('file-change:Edit src/a.ts');
  expect(text).toContain('error:Process exited with code 1');
  expect(text).toContain('error:boom');
  for (const hidden of [
    'SYSTEM PROMPT',
    'the brief',
    'wrong place',
    'a much later session',
    'sk-abcdefghijklmnopqrstuv',
    'hunter2hunter2',
  ])
    expect(text).not.toContain(hidden);
  expect(text).toContain('<img src=x onerror=alert(1)>'); // markup stays plain text; the page places it with textContent
  expect(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123 and Bearer abcdefghijklmnop')).not.toMatch(
    /ghp_abc|abcdefghijklmnop/,
  );
});

it('pages by how many items the page already has and ignores a line still being written', async () => {
  const d = await dispatched();
  const t = transcripts(wt(d.dir), d.startedAt);
  const all = readActivity(d.events, 'disp-w', undefined, t.roots)!;
  expect(readActivity(d.events, 'disp-w', all.total - 2, t.roots)!.items).toHaveLength(2);
  expect(readActivity(d.events, 'disp-w', all.total, t.roots)!.items).toEqual([]);
  expect(JSON.stringify(all)).not.toContain('"mess');
});

it('says so, and does not fail, when there is no transcript or no recorded worktree; unknown dispatches are refused', async () => {
  const d = await dispatched();
  const none = mkdtempSync(join(tmpdir(), 'apos-ui-none-'));
  dirs.push(none);
  const missing = readActivity(d.events, 'disp-w', undefined, { codex: none, claude: none })!;
  expect(missing).toMatchObject({ found: false, items: [] });
  expect(missing.reason).toMatch(/No transcript was found.*Codex, Claude Code and Antigravity/);
  expect(readActivity(d.events, 'disp-nope', undefined, { codex: none, claude: none })).toBeUndefined();
  const bare = await dispatched(() => undefined);
  expect(readActivity(bare.events, 'disp-w', undefined, { codex: none, claude: none })!.reason).toMatch(
    /did not record a worktree/,
  );
});

it('serves activity through a read-only route that takes an id, never a path', async () => {
  const d = await dispatched();
  const t = transcripts(wt(d.dir), d.startedAt);
  const before = hashTree(d.home),
    beforeTranscripts = hashTree(t.root);
  const ok = route(d.home, new URL('/api/goals/GOAL-W/activity/disp-w', 'http://localhost'), t.roots);
  expect(ok.status).toBe(200);
  expect(JSON.parse(ok.body).items.length).toBeGreaterThan(3);
  for (const bad of [
    '/api/goals/GOAL-W/activity/..%2F..%2Fx',
    '/api/goals/GOAL-W/activity/a%20b',
    '/api/goals/GOAL-W/activity/disp-w?after=-1',
    '/api/goals/GOAL-W/activity/disp-w?after=abc',
  ]) {
    expect(route(d.home, new URL(bad, 'http://localhost'), t.roots).status).toBe(400);
  }
  expect(route(d.home, new URL('/api/goals/GOAL-W/activity/disp-other', 'http://localhost'), t.roots).status).toBe(404);
  expect(hashTree(d.home)).toBe(before);
  expect(hashTree(t.root)).toBe(beforeTranscripts);
  expect(buildStory(new ReadOnlyJournal(d.home), 'GOAL-W')!.owners[0].dispatches).toEqual([
    expect.objectContaining({ dispatchId: 'disp-w', role: 'worker' }),
  ]);
});

it('ships page script that parses (a stray quote once blanked the whole page)', async () => {
  const { PAGE } = await import('./page.js');
  const script = /<script>([\s\S]*)<\/script>/.exec(PAGE)?.[1] ?? '';
  expect(script.length).toBeGreaterThan(1000);
  expect(() => new Function(script)).not.toThrow();
});

it('shows a Codex session that ended in an error at start instead of "no transcript" (GitHub #6)', async () => {
  const d = await dispatched();
  const root = mkdtempSync(join(tmpdir(), 'apos-ui-err-'));
  dirs.push(root);
  const day = new Date(d.startedAt);
  const codexDir = join(
    root,
    'codex',
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  );
  mkdirSync(codexDir, { recursive: true });
  const at = new Date(d.startedAt + 3000).toISOString();
  writeFileSync(
    join(codexDir, 'rollout-err.jsonl'),
    row({ timestamp: new Date(d.startedAt + 1000).toISOString(), type: 'session_meta', payload: { cwd: wt(d.dir) } }) +
      row({
        timestamp: at,
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          error: { message: 'You’ve hit your usage limit. Upgrade to Pro.', codex_error_info: 'usage_limit_exceeded' },
        },
      }),
  );
  const reply = readActivity(d.events, 'disp-w', undefined, {
    codex: join(root, 'codex'),
    claude: join(root, 'none'),
  })!;
  expect(reply.found).toBe(true);
  expect(reply.items).toEqual([
    expect.objectContaining({ kind: 'error', text: expect.stringContaining('usage limit') }),
  ]);
});

it('includes dispatches created via apos handoff in story owners[].dispatches and serves their activity (#26)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-ui-ho-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-ui-ho-home-'));
  dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  const opened = ProjectJournal.open(dir, home);
  let n = 0;
  const baseAt = Date.parse('2026-11-18T03:00:00.000Z');
  const add = (type: GoalEventType, data?: unknown) =>
    opened.journal.append({
      id: `EV-${++n}`,
      goalId: 'GOAL-H',
      type,
      data,
      at: new Date(baseAt + n * 1000).toISOString(),
    });
  opened.journal.appendWithSource(
    {
      id: `EV-${++n}`,
      goalId: 'GOAL-H',
      type: 'goal-drafted',
      data: { ...spec, id: 'GOAL-H' },
      at: new Date(baseAt + n * 1000).toISOString(),
    },
    sourceText,
  );
  const base = 'a'.repeat(40);
  const delivery = 'b'.repeat(40);
  add('goal-approved', approval);
  add('goal-selected');
  add('lead-dispatch-intended', 'lk');
  add('lead-started', {
    runId: 'run_1',
    taskId: 't_lead',
    dispatchId: 'ctx_lead_1',
    repoPath: dir,
    terminal: 'term_1',
    worktreeId: `repo::${wt(dir)}`,
    baseCommit: base,
  });
  add('proposal-drafted', { ...proposal, goalId: 'GOAL-H', baseCommit: base });
  add('proposal-approved');
  add('execution-started', {
    runId: 'run_1',
    taskId: 't_lead',
    dispatchId: 'ctx_lead_1',
    owner: 'lead',
    repoPath: dir,
    terminal: 'term_1',
    worktreeId: `repo::${wt(dir)}`,
    baseCommit: base,
  });
  add('gate-recorded', {
    gateId: 'G-1',
    goalId: 'GOAL-H',
    goalVersion: 1,
    sourceSha256: spec.source.sha256,
    baseCommit: base,
    deliveryCommit: delivery,
    attemptKey: attemptKey(opened.journal.getGoal('GOAL-H')!),
    phase: 'delivery',
    changedFiles: ['a.js'],
    environment: { platform: 'win32', shell: 'cmd', node: 'v24' },
    checks: [],
    result: 'green',
    at: new Date(baseAt + 10_000).toISOString(),
  });
  add('review-intended', { key: 'rk1', commit: delivery });
  add('review-dispatched', {
    dispatchId: 'ctx_rev_1',
    runId: 'run_1',
    key: 'rk1',
    commit: delivery,
    worktreeId: `repo::${join(dir, 'rev-wt')}`,
    terminal: 'term_rev_1',
  });
  add('handoff-intended', { key: 'hk1', target: { kind: 'reviewer' }, from: 'ctx_rev_1', runId: 'run_1' });
  add('owner-handed-off', {
    key: 'hk1',
    target: { kind: 'reviewer' },
    from: 'ctx_rev_1',
    ref: {
      dispatchId: 'ctx_rev_2',
      runId: 'run_1',
      key: 'hk1',
      commit: delivery,
      worktreeId: `repo::${join(dir, 'rev-wt')}`,
      terminal: 'term_rev_2',
      requested: { agent: 'antigravity' },
    },
  });
  opened.close();
  const story = buildStory(new ReadOnlyJournal(home), 'GOAL-H')!;
  expect(story.owners[0].dispatches.map(d => `${d.role}:${d.dispatchId}`)).toEqual([
    'lead:ctx_lead_1',
    'reviewer:ctx_rev_1',
    'reviewer:ctx_rev_2',
  ]);
  const res = route(home, new URL('/api/goals/GOAL-H/activity/ctx_rev_2', 'http://localhost'), {
    codex: join(dir, 'none'),
    claude: join(dir, 'none'),
    antigravity: join(dir, 'none'),
  });
  expect(res.status).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.found).toBe(false);
  expect(body.reason).not.toMatch(/No Codex or Claude Code transcript/);
  expect(body.reason).toContain('Antigravity');
  expect(body.reason).toContain('orca orchestration worker-read --dispatch ctx_rev_2');
});

it('reads Antigravity transcripts by worktree and time without touching the Antigravity folder (#25)', async () => {
  const d = await dispatched();
  const agyRoot = mkdtempSync(join(tmpdir(), 'apos-ui-agy-'));
  dirs.push(agyRoot);
  const convId = '565fab09-7316-453f-bd7f-ef85c19f426a';
  const iso = (seconds: number) => new Date(d.startedAt + seconds * 1000).toISOString();
  writeFileSync(
    join(agyRoot, 'history.jsonl'),
    row({ display: 'the brief', timestamp: d.startedAt + 500, workspace: wt(d.dir), conversationId: convId }),
  );
  const logDir = join(agyRoot, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, 'transcript.jsonl'),
    row({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: iso(1),
      content: '<USER_REQUEST>\nthe secret brief\n</USER_REQUEST>',
    }) +
      row({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: iso(2),
        thinking: 'internal reasoning that must stay hidden',
        content: 'Implementing the workspace sync now. Token sk-abcdefghijklmnopqrstuv',
        tool_calls: [
          { name: 'write_file', args: { Path: JSON.stringify(join(wt(d.dir), 'src/sync.js')) } },
          { name: 'run_command', args: { CommandLine: JSON.stringify('npm test') } },
        ],
      }) +
      row({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'ERROR',
        created_at: iso(3),
        content:
          'Created At: 2026-11-18T11:00:03+07:00\nCompleted At: 2026-11-18T11:00:04+07:00\nCommand exited with code 1.\nFAIL sync.test.js',
      }),
  );
  const before = hashTree(agyRoot);
  const reply = readActivity(d.events, 'disp-w', undefined, {
    codex: join(agyRoot, 'none'),
    claude: join(agyRoot, 'none'),
    antigravity: agyRoot,
  })!;
  expect(hashTree(agyRoot)).toBe(before);
  expect(reply.found).toBe(true);
  expect(reply.matched).toEqual([{ agent: 'antigravity', name: 'transcript.jsonl' }]);
  const text = reply.items.map(item => `${item.kind}:${item.text}`).join('\n');
  expect(text).toContain('say:Implementing the workspace sync now.');
  expect(text).toContain('file-change:write_file');
  expect(text).toContain('command:npm test');
  expect(text).toContain('error:Command exited with code 1.');
  expect(text).not.toContain('internal reasoning');
  expect(text).not.toContain('the secret brief');
  expect(text).not.toContain('sk-abcdefghijklmnopqrstuv');
});
