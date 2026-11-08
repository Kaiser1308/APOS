import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSessionProbe } from './telemetry.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('attributes tokens per dispatch when a resume continues the same cumulative Codex session', () => {
  const root = mkdtempSync(join(tmpdir(), 'apos-codex-')); dirs.push(root);
  const day = join(root, '2026', '11', '08'); mkdirSync(day, { recursive: true });
  const row = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });
  const tokens = (timestamp: string, input: number, cached: number, output: number) => row(timestamp, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } });
  writeFileSync(join(day, 'rollout-a.jsonl'), [
    row('2026-11-08T01:26:40Z', 'session_meta', { cwd: 'C:\\wt\\owner', timestamp: '2026-11-08T01:26:40Z' }),
    row('2026-11-08T01:26:41Z', 'turn_context', { model: 'gpt-6.1-terra' }),
    tokens('2026-11-08T01:27:00Z', 100, 90, 5),
    tokens('2026-11-08T01:28:00Z', 300, 280, 20),
    tokens('2026-11-08T01:31:00Z', 550, 520, 35)
  ].join('\n'));
  writeFileSync(join(day, 'rollout-other.jsonl'), [row('2026-11-08T01:27:00Z', 'session_meta', { cwd: 'C:\\elsewhere' }), tokens('2026-11-08T01:27:30Z', 9999, 0, 9)].join('\n'));
  const probe = new CodexSessionProbe(root);
  expect(probe.usage({ worktreePath: 'C:/wt/owner', since: '2026-11-08T01:26:30Z', until: '2026-11-08T01:28:10Z' })).toMatchObject({ inputTokens: 300, cachedInputTokens: 280, outputTokens: 20, model: 'gpt-6.1-terra' });
  expect(probe.usage({ worktreePath: 'C:/wt/owner', since: '2026-11-08T01:30:00Z', until: '2026-11-08T01:32:00Z' })).toMatchObject({ inputTokens: 250, cachedInputTokens: 240, outputTokens: 15 });
  expect(probe.usage({ worktreePath: 'C:/wt/nobody', since: '2026-11-08T01:26:30Z', until: '2026-11-08T01:32:00Z' })).toBeUndefined();
});
