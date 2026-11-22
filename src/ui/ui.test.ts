import { newEvent } from '../app/events.js';
import { afterEach, expect, it, vi } from 'vitest';

// Seeding commits milestone documents to git, which is slow on a busy machine.
vi.setConfig({ testTimeout: 60_000 });
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { request, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { runCli } from '../cli.js';
import { initProject } from '../app/init-project.js';
import { buildInbox } from '../app/inbox.js';
import { buildHumanInbox } from '../app/wait.js';
import { ProjectJournal } from '../store/journal.js';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import {
  DELIVERY,
  approval,
  gateReport,
  proposal,
  soloGreen,
  sourceText,
  spec,
} from '../domain/fixtures.test-support.js';
import type { GoalEventType, GoalStatus } from '../domain/transitions.js';
import { attemptKey } from '../domain/gate.js';
import { buildStory } from './story.js';
import { HOLDER, buildGoalDetail, buildSnapshot, findGateLog } from './read-model.js';
import { PAGE } from './page.js';
import { route, startUi } from './server.js';

// These tests build scratch Git repos and spawn many git processes; a loaded parallel run on Windows measured 3-5x slower than alone, past the default.
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const at = '2026-11-07T00:00:00.000Z';

async function project() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-ui-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-ui-home-'));
  dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  const opened = ProjectJournal.open(dir, home, newEvent);
  let n = 0;
  const goal = (id: string) => ({
    spec: { ...spec, id },
    add: (type: GoalEventType, data?: unknown) =>
      opened.journal.append({
        id: `EV-${++n}`,
        goalId: id,
        type,
        data,
        at: new Date(Date.parse(at) + n * 1000).toISOString(),
      }),
    draft: () =>
      opened.journal.appendWithSource(
        {
          id: `EV-${++n}`,
          goalId: id,
          type: 'goal-drafted',
          data: { ...spec, id },
          at: new Date(Date.parse(at) + n * 1000).toISOString(),
        },
        sourceText,
      ),
  });
  return { dir, home, goal, ...opened };
}

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

/** Two Goals in different states: GOAL-A awaits gate A, GOAL-B is blocked while executing. */
async function seeded() {
  const p = await project();
  const a = p.goal('GOAL-A');
  a.draft();
  const b = p.goal('GOAL-B');
  b.draft();
  b.add('goal-approved', approval);
  b.add('goal-selected');
  b.add('proposal-drafted', { ...proposal, goalId: 'GOAL-B' });
  b.add('proposal-approved');
  b.add('blocked', { kind: 'technical', note: 'needs a decision <script>alert(1)</script>' });
  b.add('human-notified', { kind: 'idle', goalId: 'GOAL-B', note: 'quiet' });
  return p;
}

it('shows what apos inbox shows, gates A and B included (#28)', async () => {
  const p = await seeded();
  const c = p.goal('GOAL-C');
  c.draft();
  c.add('goal-approved', approval);
  const lines: string[] = [];
  await runCli(['--repo', p.dir, 'inbox'], { home: p.home, write: line => lines.push(line) });
  const readOnly = new ReadOnlyJournal(p.home);
  expect(buildHumanInbox(readOnly).map(item => `${item.goalId}\t${item.kind}\t${item.detail}`)).toEqual(lines);
  expect(lines.some(line => line.includes('awaiting-approval'))).toBe(true);
  expect(lines.some(line => line.includes('needs-decision'))).toBe(true);
  expect(lines.some(line => line.includes('notice'))).toBe(true);
  const kinds = buildSnapshot(readOnly).inbox.map(item => `${item.goalId}:${item.kind}`);
  expect(kinds).toContain('GOAL-A:awaiting-approval');
  expect(kinds).toContain('GOAL-C:awaiting-selection');
  expect(kinds).toContain('GOAL-B:needs-decision');
  p.close();
});

it('groups every status under exactly one holder', () => {
  const statuses: GoalStatus[] = [
    'draft',
    'approved',
    'selected',
    'planned',
    'testing',
    'executing',
    'blocked',
    'verified',
    'closed',
    'stopped',
    'legacy',
  ];
  expect(Object.keys(HOLDER).sort()).toEqual([...statuses].sort());
  expect(HOLDER.legacy).toBe('done');
  expect(HOLDER.verified).toBe('human');
  expect(HOLDER.planned).toBe('lead');
});

it('never changes the controller home, even for a torn final line, and ignores the torn line', async () => {
  const p = await seeded();
  p.close();
  const file = join(p.home, 'events', 'GOAL-A.jsonl');
  appendFileSync(file, '{"event":{"id":"EV-torn"'); // a write the controller has not finished
  const before = hashTree(p.home);
  const tornSize = statSync(file).size;
  const urls = [
    '/',
    '/api/snapshot',
    '/api/goals/GOAL-A',
    '/api/goals/GOAL-B',
    '/api/goals/GOAL-B?limit=2',
    '/api/goals/GOAL-B/source/1',
  ];
  for (let i = 0; i < 100; i++) for (const url of urls) route(p.home, new URL(url, 'http://localhost'));
  expect(hashTree(p.home)).toBe(before);
  expect(statSync(file).size).toBe(tornSize);
  const detail = JSON.parse(route(p.home, new URL('/api/goals/GOAL-A', 'http://localhost')).body);
  expect(detail.status).toBe('draft');
  // The assurance table is part of the read model: a Goal with no setup says so.
  expect(detail.assuranceText).toContain('GOAL-A  không có setup');
  expect(detail.assurance.guards).toBe(false);
  expect(JSON.stringify(detail.timeline.events)).not.toContain('EV-torn');
});

it('reports a broken hash chain on that Goal only', async () => {
  const p = await seeded();
  p.close();
  const file = join(p.home, 'events', 'GOAL-A.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"outcome":"check in"', '"outcome":"check out"'));
  const snapshot = buildSnapshot(new ReadOnlyJournal(p.home));
  const a = snapshot.goals.find(item => item.id === 'GOAL-A')!;
  const b = snapshot.goals.find(item => item.id === 'GOAL-B')!;
  expect(a.integrityError).toMatch(/modified at line 1/);
  expect(b.integrityError).toBeUndefined();
  expect(b.status).toBe('blocked');
  expect(route(p.home, new URL('/api/goals/GOAL-A', 'http://localhost')).status).toBe(409);
});

it('serves detail with a paged timeline, newest first', async () => {
  const p = await seeded();
  p.close();
  const repo = new ReadOnlyJournal(p.home);
  const first = buildGoalDetail(repo, 'GOAL-B', { limit: 3 })!;
  expect(first.timeline.nextBefore).toBeDefined();
  const second = buildGoalDetail(repo, 'GOAL-B', { limit: 3, before: first.timeline.nextBefore })!;
  expect(second.timeline.events.map(item => item.type)).toContain('proposal-approved');
  expect(first.blocker).toMatchObject({ kind: 'technical' });
  expect(JSON.stringify(first)).toContain('<script>'); // data is passed through; the page must not interpret it
});

it('finds a gate log only by the hash the controller recorded', () => {
  const report = {
    checks: [
      {
        base: [{ logSha256: 'a'.repeat(64), logRef: '/x/base.log' }],
        delivery: [{ logSha256: 'b'.repeat(64), logRef: '/x/delivery.log' }],
      },
    ],
  };
  const state = { gate: report, packages: {} } as never;
  expect(findGateLog(state, 'b'.repeat(64))).toBe('/x/delivery.log');
  expect(findGateLog(state, 'c'.repeat(64))).toBeUndefined();
});

it('serves gate logs from the Goal artifact folder and refuses anything else', async () => {
  const p = await seeded();
  p.close();
  expect(route(p.home, new URL(`/api/goals/GOAL-B/gate-log/${'a'.repeat(64)}`, 'http://localhost')).status).toBe(404);
  expect(route(p.home, new URL('/api/goals/GOAL-B/gate-log/..%2F..%2Fsecret', 'http://localhost')).status).toBe(400);
  expect(route(p.home, new URL('/api/goals/GOAL-B/source/..%2F1', 'http://localhost')).status).toBe(400);
  expect(route(p.home, new URL('/api/goals/goal-b', 'http://localhost')).status).toBe(400);
  expect(route(p.home, new URL('/api/goals/GOAL-NOPE', 'http://localhost')).status).toBe(404);
  mkdirSync(join(p.home, 'sources', 'GOAL-B'), { recursive: true });
  expect(route(p.home, new URL('/api/goals/GOAL-B/source/1', 'http://localhost')).status).toBe(200);
});

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

it('listens on loopback only, is read-only, and refuses foreign Host headers', async () => {
  const p = await seeded();
  p.close();
  const server = await startUi(p.home, 0);
  servers.push(server);
  const { address, port } = server.address() as AddressInfo;
  expect(address).toBe('127.0.0.1');
  const page = await call(port, 'GET', '/');
  expect(page.status).toBe(200);
  expect(page.body).toContain('<title>APOS</title>');
  expect((await call(port, 'GET', '/api/snapshot')).status).toBe(200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
    expect((await call(port, method, '/api/snapshot')).status).toBe(405);
  expect((await call(port, 'GET', '/api/snapshot', { Host: 'evil.example' })).status).toBe(403);
  expect((await call(port, 'GET', '/api/snapshot', { Host: `evil.example:${port}` })).status).toBe(403);
  expect((await call(port, 'GET', '/api/snapshot', { Host: `localhost:${port}` })).status).toBe(200);
  expect((await call(port, 'GET', '/api/goals/..%2F..%2Fetc/x')).status).toBe(400);
});

it('refuses to start on a port that is taken', async () => {
  const p = await seeded();
  p.close();
  const first = await startUi(p.home, 0);
  servers.push(first);
  const { port } = first.address() as AddressInfo;
  await expect(startUi(p.home, port)).rejects.toThrow(/already in use/);
});

it('places agent-written text with textContent, never as markup', () => {
  expect(PAGE).not.toContain('innerHTML');
  expect(PAGE).not.toContain('outerHTML');
  expect(PAGE).not.toContain('insertAdjacentHTML');
  expect(PAGE).not.toContain('document.write');
  expect(PAGE).not.toMatch(/\beval\(/);
});

it('measures wall time from goal select, to now while the Goal is on the clock', async () => {
  const p = await seeded();
  const d = p.goal('GOAL-D');
  d.draft();
  d.add('goal-approved', approval);
  d.add('goal-selected');
  d.add('proposal-drafted', { ...proposal, goalId: 'GOAL-D' });
  d.add('proposal-approved');
  p.close();
  const repo = new ReadOnlyJournal(p.home);
  const started = Date.parse(repo.events('GOAL-D').find(item => item.type === 'goal-selected')!.at);
  const goal = (minutes: number) =>
    buildSnapshot(repo, () => new Date(started + minutes * 60_000)).goals.find(item => item.id === 'GOAL-D')!;
  expect(goal(90).elapsedMinutes).toBe(90);
  expect(goal(1).elapsedMinutes).toBe(1);
  expect(goal(90).attempts).toBe(0);
  expect(buildSnapshot(repo).goals.find(item => item.id === 'GOAL-A')!.elapsedMinutes).toBe(0); // never started
});

it('serves a gate log from the Goal artifact folder, and refuses one whose stored path points elsewhere', async () => {
  const p = await seeded();
  const d = p.goal('GOAL-D');
  d.draft();
  d.add('goal-approved', approval);
  d.add('goal-selected');
  d.add('proposal-drafted', { ...proposal, goalId: 'GOAL-D' });
  d.add('proposal-approved');
  const inside = join(p.home, 'artifacts', 'GOAL-D', 'GATE-test', 'CHK-1-delivery-1.log');
  const outside = join(p.home, 'secret.txt');
  mkdirSync(join(inside, '..'), { recursive: true });
  writeFileSync(inside, 'delivery output');
  writeFileSync(outside, 'not an artifact');
  const run = (logRef: string, logSha256: string) => ({
    commit: DELIVERY,
    exitCode: 0,
    timedOut: false,
    logRef,
    logSha256,
    failures: [],
  });
  const report = {
    ...gateReport(DELIVERY, 'green', { ...spec, id: 'GOAL-D' }),
    attemptKey: attemptKey(p.journal.getGoal('GOAL-D')!),
    checks: [
      {
        checkId: 'CHK-1',
        status: 'pass',
        reason: 'ok',
        base: [run(outside, 'b'.repeat(64))],
        delivery: [run(inside, 'a'.repeat(64))],
        newFailures: [],
      },
    ],
  };
  d.add('gate-recorded', report);
  p.close();
  const ok = route(p.home, new URL(`/api/goals/GOAL-D/gate-log/${'a'.repeat(64)}`, 'http://localhost'));
  expect(ok.status).toBe(200);
  expect(ok.body).toBe('delivery output');
  expect(route(p.home, new URL(`/api/goals/GOAL-D/gate-log/${'b'.repeat(64)}`, 'http://localhost')).status).toBe(404);
  const detail = JSON.parse(route(p.home, new URL('/api/goals/GOAL-D', 'http://localhost')).body);
  expect(detail.gates[0]).toMatchObject({ scope: 'goal', result: 'green' });
  expect(detail.gates[0].checks[0].logs.map((log: { role: string }) => log.role)).toEqual(['base', 'delivery']);
});

it('leaves out notices that are history or repeat the status, in the UI and in apos inbox alike', async () => {
  const p = await project();
  const closed = p.goal('GOAL-X');
  closed.draft();
  closed.add('goal-approved', approval);
  closed.add('goal-selected');
  closed.add('proposal-drafted', { ...proposal, goalId: 'GOAL-X' });
  closed.add('proposal-approved');
  closed.add('human-notified', { kind: 'idle', goalId: 'GOAL-X', note: 'old' });
  for (const item of soloGreen()) closed.add(item.type, item.data);
  closed.add('verified', { deliveryCommit: DELIVERY });
  closed.add('human-notified', { kind: 'awaiting-outcome', goalId: 'GOAL-X' });
  const open = p.goal('GOAL-Y');
  open.draft();
  open.add('goal-approved', approval);
  open.add('goal-selected');
  open.add('proposal-drafted', { ...proposal, goalId: 'GOAL-Y' });
  open.add('proposal-approved');
  open.add('human-notified', { kind: 'idle', goalId: 'GOAL-Y', note: 'still quiet' });
  const done = p.goal('GOAL-Z');
  done.draft();
  done.add('goal-approved', approval);
  done.add('goal-selected');
  done.add('proposal-drafted', { ...proposal, goalId: 'GOAL-Z' });
  done.add('proposal-approved');
  done.add('human-notified', { kind: 'idle', goalId: 'GOAL-Z', note: 'ancient' });
  for (const item of soloGreen()) done.add(item.type, item.data);
  done.add('verified', { deliveryCommit: DELIVERY });
  done.add('outcome-accepted');
  p.close();
  const repo = new ReadOnlyJournal(p.home);
  expect(repo.getGoal('GOAL-Z')?.status).toBe('closed');
  // X is verified: its status item stays once, its idle notice stays, the repeated awaiting-outcome notice goes. Z is closed: nothing.
  expect(buildSnapshot(repo).inbox.map(item => `${item.goalId}:${item.kind}`)).toEqual([
    'GOAL-X:awaiting-outcome',
    'GOAL-X:notice',
    'GOAL-Y:notice',
  ]);
  expect(buildInbox(repo).filter(item => item.goalId === 'GOAL-X')).toHaveLength(2); // CLI: status item plus the idle notice
  expect(buildInbox(repo).filter(item => item.goalId === 'GOAL-Z')).toHaveLength(0); // CLI: the closed Goal's notice is history
});

it('tells the story of a Goal: what the Human gave, what the Lead decided, and what each owner put on record', async () => {
  const p = await project();
  const g = p.goal('GOAL-S');
  g.draft();
  g.add('goal-approved', approval);
  g.add('goal-selected');
  g.add('proposal-drafted', {
    ...proposal,
    goalId: 'GOAL-S',
    approach: 'reuse the <b>API</b>',
    splitRationale: undefined,
  });
  const before = buildStory(new ReadOnlyJournal(p.home), 'GOAL-S')!;
  expect(before.lead).toMatchObject({ mode: 'solo-direct', approved: false, approach: 'reuse the <b>API</b>' });
  expect(before.lead!.modeLabel).toMatch(/1 owner/);
  expect(before.lead!.whySplit).toMatch(/không ghi lý do chia/);
  expect(before.lead!.whySplit).toContain('not recorded');
  g.add('proposal-revised', {
    ...proposal,
    version: 2,
    goalId: 'GOAL-S',
    approach: 'reuse the <b>API</b>',
    splitRationale: undefined,
    rationale: 'repo trống, các mảng phụ thuộc chặt vào model chung',
  });
  expect(buildStory(new ReadOnlyJournal(p.home), 'GOAL-S')!.lead!.whySplit).toBe(
    'repo trống, các mảng phụ thuộc chặt vào model chung',
  );
  g.add('proposal-approved');
  g.add('decision-logged', { note: 'cookie session, not JWT' });
  g.add('blocked', { kind: 'technical', note: 'need a decision' });
  p.close();
  const story = buildStory(new ReadOnlyJournal(p.home), 'GOAL-S')!;
  expect(story.goal.requirements[0].id).toBe('R-1');
  expect(story.lead!.approved).toBe(true);
  expect(story.owners).toHaveLength(1);
  expect(story.owners[0].entries.map(item => `${item.kind}:${item.text}`)).toEqual([
    'decision:cookie session, not JWT',
    'blocker:technical: need a decision',
  ]);
  const reply = route(p.home, new URL('/api/goals/GOAL-S/story', 'http://localhost'));
  expect(reply.status).toBe(200);
  expect(JSON.parse(reply.body).owners[0].entries).toHaveLength(2);
  expect(route(p.home, new URL('/api/goals/GOAL-NOPE/story', 'http://localhost')).status).toBe(404);
});

it('splits a Multi-WP story per package and keeps Lead-level notes apart', async () => {
  const p = await project();
  const g = p.goal('GOAL-M');
  g.draft();
  g.add('goal-approved', approval);
  g.add('goal-selected');
  g.add('proposal-drafted', {
    ...proposal,
    goalId: 'GOAL-M',
    mode: 'multi-wp',
    splitRationale: 'two modules are independent',
    estimatedCost: { spendUsd: 8, wallMinutes: 90 },
  });
  p.close();
  const story = buildStory(new ReadOnlyJournal(p.home), 'GOAL-M')!;
  expect(story.lead).toMatchObject({ mode: 'multi-wp', whySplit: 'two modules are independent' });
  expect(story.lead!.modeLabel).toMatch(/Chia nhiều/);
});

it('shows a Goal an older APOS recorded as read-only, and has no agent, terminal or token view left', () => {
  const fixture = join(import.meta.dirname, '..', 'store', 'fixtures', 'replay', 'legacy-solo');
  const snapshot = buildSnapshot(new ReadOnlyJournal(fixture));
  expect(snapshot.goals.map(item => [item.id, item.status, item.legacy, item.legacyOutcome, item.holder])).toEqual([
    ['GOAL-SMOKE-R', 'legacy', true, 'closed', 'done'],
    ['GOAL-SMOKE-V2', 'legacy', true, 'closed', 'done'],
  ]);
  expect(snapshot).not.toHaveProperty('tickRunning');
  expect(snapshot.inbox).toEqual([]);
  expect(PAGE).toContain('chỉ đọc – APOS cũ');
  for (const gone of ['telemetry', 'Telemetry', 'activity', 'Tokens', 'tick running', 'dispatches'])
    expect(PAGE, gone).not.toContain(gone);
  expect(route(fixture, new URL('/api/goals/GOAL-SMOKE-V2/activity/ctx_1', 'http://localhost')).status).toBe(404);
});
