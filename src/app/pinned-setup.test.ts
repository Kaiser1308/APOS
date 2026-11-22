import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPinnedSetup } from './pinned-setup.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { parseProjectSetup } from '../domain/project-setup.js';
import { replaySetupHistory } from '../domain/setup-history.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('reads the setup at the approved commit, not the one later committed, and none without a pin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-pinned-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, '.apos'));
  const write = (note: string) => {
    const text = jsonCodec.stringify({
      schemaVersion: 2,
      parts: { app: { root: '.', layers: {}, needsHuman: [], forbid: [], note } },
    });
    writeFileSync(join(dir, '.apos', 'project.yaml'), text);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-qm', note]);
    return { text, commit: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
  };
  const first = write('first');
  write('second');
  const sha256 = (parseProjectSetup(first.text, jsonCodec) as { sha256: string }).sha256;
  const history = replaySetupHistory([
    { id: 'p', type: 'setup-probed', at: 'x', data: { sha256, commit: first.commit, ok: true, results: [] } },
    {
      id: 'a',
      type: 'setup-approved',
      at: 'x',
      data: { version: 1, sha256, commit: first.commit, confirmation: { by: 'human' } },
    },
  ]);
  expect(loadPinnedSetup(dir, history, 1, jsonCodec)?.parts.app?.note).toBe('first');
  expect(loadPinnedSetup(dir, history, undefined, jsonCodec)).toBeUndefined();
  expect(() => loadPinnedSetup(dir, history, 2, jsonCodec)).toThrow(/never approved/);
});
