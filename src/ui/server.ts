import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import { buildGoalDetail, buildSnapshot, findGateLog } from './read-model.js';
import { buildStory } from './story.js';
import { PAGE } from './page.js';

export const DEFAULT_UI_PORT = 4343;
const MAX_TEXT_BYTES = 1_000_000;
const GOAL_ID = /^GOAL-[A-Z0-9-]+$/;

type Reply = { status: number; type: string; body: string };
const json = (status: number, value: unknown): Reply => ({
  status,
  type: 'application/json; charset=utf-8',
  body: JSON.stringify(value),
});
const text = (status: number, body: string): Reply => ({ status, type: 'text/plain; charset=utf-8', body });

function within(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function readCapped(path: string): string {
  const raw = readFileSync(path);
  return raw.length > MAX_TEXT_BYTES
    ? `${raw.subarray(0, MAX_TEXT_BYTES).toString('utf8')}\n… truncated at ${MAX_TEXT_BYTES} bytes`
    : raw.toString('utf8');
}

/** Read-only routes. Everything is looked up by id in what the controller recorded; no request names a path. */
export function route(home: string, url: URL): Reply {
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/') return { status: 200, type: 'text/html; charset=utf-8', body: PAGE };
  if (parts[0] !== 'api') return text(404, 'not found');
  const repo = new ReadOnlyJournal(home);
  if (parts.length === 2 && parts[1] === 'snapshot') return json(200, buildSnapshot(repo));
  if (parts[1] !== 'goals' || !parts[2]) return text(404, 'not found');
  const goalId = parts[2];
  if (!GOAL_ID.test(goalId)) return text(400, 'invalid Goal id');
  const state = repo.getGoal(goalId);
  if (!state)
    return repo.failures.has(goalId) ? json(409, { error: repo.failures.get(goalId) }) : text(404, 'unknown Goal');
  if (parts.length === 3) {
    const limit = Number(url.searchParams.get('limit') ?? 200);
    const before = url.searchParams.get('before') ?? undefined;
    return json(200, buildGoalDetail(repo, goalId, { limit: Number.isFinite(limit) ? limit : 200, before }));
  }
  if (parts.length === 4 && parts[3] === 'story') return json(200, buildStory(repo, goalId));
  if (parts.length === 5 && parts[3] === 'gate-log') {
    if (!/^[0-9a-f]{64}$/.test(parts[4])) return text(400, 'invalid log id');
    const ref = findGateLog(state, parts[4]);
    if (!ref || !within(join(repo.artifactRoot(), goalId), ref) || !existsSync(ref)) return text(404, 'unknown log');
    return text(200, readCapped(ref));
  }
  if (parts.length === 5 && parts[3] === 'source') {
    if (!/^[1-9][0-9]{0,5}$/.test(parts[4])) return text(400, 'invalid version');
    const path = repo.sourcePath(goalId, Number(parts[4]));
    return existsSync(path) ? text(200, readCapped(path)) : text(404, 'unknown source version');
  }
  return text(404, 'not found');
}

export function handle(home: string, port: () => number, req: IncomingMessage, res: ServerResponse): void {
  const send = (reply: Reply) => {
    res.writeHead(reply.status, {
      'Content-Type': reply.type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    });
    res.end(reply.body);
  };
  // A page on another origin can make the browser send requests here; only our own host names are served.
  const host = (req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port()}` && host !== `localhost:${port()}`) return send(text(403, 'forbidden host'));
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return send(text(405, 'read-only'));
  }
  try {
    send(route(home, new URL(req.url ?? '/', 'http://localhost')));
  } catch (error) {
    send(json(500, { error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Starts the read-only UI on loopback. Resolves once it is listening; rejects when the port is taken. */
export function startUi(home: string, port: number = DEFAULT_UI_PORT): Promise<Server> {
  return new Promise((resolveStart, reject) => {
    let actual = port;
    const server = createServer((req, res) => handle(home, () => actual, req, res));
    server.once('error', error =>
      reject(
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use; choose another with --port`)
          : error,
      ),
    );
    server.listen(port, '127.0.0.1', () => {
      actual = (server.address() as AddressInfo).port;
      resolveStart(server);
    });
  });
}
