import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type Usage = { model?: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; sessions: number };
export interface TelemetryProbe { usage(input: { worktreePath: string; since: string; until: string }): Usage | undefined }

const norm = (path: string) => resolve(path).replace(/\\/g, '/').toLowerCase();

/**
 * Reads Codex rollout files whose session cwd is the owner's worktree and that were active in the
 * dispatch window. Each file's last cumulative token count is that session's usage. Returns
 * undefined when nothing matches, so callers record `unknown` instead of guessing.
 */
export class CodexSessionProbe implements TelemetryProbe {
  constructor(private readonly root: string = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')) {}

  usage(input: { worktreePath: string; since: string; until: string }): Usage | undefined {
    if (!existsSync(this.root)) return undefined;
    const since = Date.parse(input.since) - 60_000;
    const until = Date.parse(input.until) + 60_000;
    const target = norm(input.worktreePath);
    const total: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, sessions: 0 };
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.jsonl') ? [join(dir, entry.name)] : []);
    for (const file of walk(this.root)) {
      const mtime = statSync(file).mtimeMs;
      if (mtime < since) continue;
      let cwd: string | undefined;
      let model: string | undefined;
      let last: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined;
      let started: number | undefined;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let row: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
        try { row = JSON.parse(line); } catch { continue; }
        const payload = row.payload ?? {};
        if (row.type === 'session_meta' && typeof payload.cwd === 'string') { cwd = payload.cwd; started = Date.parse(String(payload.timestamp ?? row.timestamp)); }
        if (row.type === 'turn_context' && typeof payload.model === 'string') model = payload.model;
        const info = payload.type === 'token_count' ? (payload.info as { total_token_usage?: typeof last } | undefined) : undefined;
        if (info?.total_token_usage) last = info.total_token_usage;
      }
      if (!cwd || norm(cwd) !== target || (started !== undefined && started > until) || !last) continue;
      total.inputTokens += last.input_tokens ?? 0;
      total.cachedInputTokens += last.cached_input_tokens ?? 0;
      total.outputTokens += last.output_tokens ?? 0;
      total.sessions += 1;
      total.model ??= model;
    }
    return total.sessions ? total : undefined;
  }
}
