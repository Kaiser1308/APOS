import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type Usage = {
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  sessions: number;
};
export interface TelemetryProbe {
  usage(input: { worktreePath: string; since: string; until: string }): Usage | undefined;
}

type Totals = { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
const norm = (path: string) => resolve(path).replace(/\\/g, '/').toLowerCase();

/**
 * Reads Codex rollout files whose session cwd is the owner's worktree. Token counts in a rollout are
 * cumulative, and a same-terminal resume continues the same session (seen live), so a dispatch's usage
 * is the difference between the last cumulative total before the window and the last one inside it.
 * Returns undefined when nothing matches, so callers record `unknown` instead of guessing.
 */
export class CodexSessionProbe implements TelemetryProbe {
  constructor(private readonly root: string = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')) {}

  usage(input: { worktreePath: string; since: string; until: string }): Usage | undefined {
    if (!existsSync(this.root)) return undefined;
    const since = Date.parse(input.since) - 30_000;
    const until = Date.parse(input.until) + 30_000;
    const target = norm(input.worktreePath);
    const total: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, sessions: 0 };
    // Windows does not refresh mtime while Codex keeps a rollout open (seen live), so select by the
    // sessions/YYYY/MM/DD folders around the window instead.
    const days = new Set<string>();
    for (let t = since - 86_400_000; t <= until + 86_400_000; t += 86_400_000)
      for (const d of [new Date(t)])
        days.add(
          join(
            String(d.getFullYear()),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ),
        );
    const files = [...days].flatMap(day => {
      const dir = join(this.root, day);
      return existsSync(dir)
        ? readdirSync(dir)
            .filter(name => name.endsWith('.jsonl'))
            .map(name => join(dir, name))
        : [];
    });
    for (const file of files) {
      if (!statSync(file).isFile()) continue;
      let cwd: string | undefined;
      let model: string | undefined;
      let before: Totals = {};
      let inside: Totals | undefined;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let row: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const payload = row.payload ?? {};
        if (row.type === 'session_meta' && typeof payload.cwd === 'string') cwd = payload.cwd;
        if (row.type === 'turn_context' && typeof payload.model === 'string') model = payload.model;
        const totals =
          payload.type === 'token_count'
            ? (payload.info as { total_token_usage?: Totals } | undefined)?.total_token_usage
            : undefined;
        if (!totals) continue;
        const at = Date.parse(row.timestamp ?? '');
        if (at < since) before = totals;
        else if (at <= until) inside = totals;
      }
      if (!cwd || norm(cwd) !== target || !inside) continue;
      total.inputTokens += (inside.input_tokens ?? 0) - (before.input_tokens ?? 0);
      total.cachedInputTokens += (inside.cached_input_tokens ?? 0) - (before.cached_input_tokens ?? 0);
      total.outputTokens += (inside.output_tokens ?? 0) - (before.output_tokens ?? 0);
      total.sessions += 1;
      total.model ??= model;
    }
    return total.sessions ? total : undefined;
  }
}
