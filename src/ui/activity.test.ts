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
  expect(missing.reason).toMatch(/No Codex or Claude Code transcript/);
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
