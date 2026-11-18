import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { spec, sourceText } from '../domain/fixtures.test-support.js';
import { OrcaRefused } from '../runtime/orca/exec.js';
import type { RuntimeAdapter } from '../ports/runtime.js';

// These tests build scratch Git repos and spawn many git processes; a loaded parallel run on Windows measured 3-5x slower than alone, past the default.
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** Selects an approved Goal whose Lead dispatch fails with `failure`, and returns what the CLI told the Human. */
async function selectWithFailure(failure: Error): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'apos-select-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  const goalFile = join(dir, 'goal-input.json');
  const sourceFile = join(dir, 'brief.md');
  writeFileSync(goalFile, JSON.stringify(spec));
  writeFileSync(sourceFile, sourceText);
  const runtime: RuntimeAdapter = {
    async startLead() {
      throw failure;
    },
    async resumeSolo() {
      throw new Error('unused');
    },
    async inspect() {
      throw new Error('unused');
    },
  };
  const output: string[] = [];
  const invoke = (...args: string[]) => runCli(['--repo', dir, ...args], { runtime, write: line => output.push(line) });
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
  output.length = 0;
  await invoke('goal', 'select', spec.id);
  return output.join('\n');
}

it('tells the Human to retry the Lead only when Orca clearly refused the dispatch', async () => {
  const output = await selectWithFailure(
    new OrcaRefused('Orca orchestration run failed: [bad_request] nope', 'bad_request'),
  );
  expect(output).toContain(`apos lead start ${spec.id}`);
  expect(output).not.toContain('abandon-intent');
});

it('does not tell the Human to retry when the dispatch outcome is unknown: the intent must be checked and abandoned first', async () => {
  const output = await selectWithFailure(
    new Error('Orca orchestration run failed: state=failed stage=turn_start_unobserved'),
  );
  expect(output).toContain('orca orchestration task-list --run <run_id>');
  expect(output).toContain('orca orchestration run-list');
  expect(output).toContain(`apos execution abandon-intent ${spec.id} --key `);
  // `lead start` is still the step after abandoning, but it must not be offered as the immediate retry.
  expect(output).not.toMatch(/Retry with `apos lead start/);
});
