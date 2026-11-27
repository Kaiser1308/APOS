import { it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { gitState } from './env.mjs';

it('reads the real checkout identity without inherited Git or dependency-bin overrides', () => {
  const temp = mkdtempSync(join(tmpdir(), 'bench-git-state-')),
    repo = join(temp, 'repo'),
    bin = join(temp, 'node_modules', '.bin');
  mkdirSync(repo);
  mkdirSync(bin, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'file'), 'x');
  execFileSync('git', ['-C', repo, 'add', 'file']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fake = join(bin, 'git');
  writeFileSync(fake, '#!/bin/sh\nprintf fake\n');
  chmodSync(fake, 0o700);
  const state = gitState(repo, {
    ...process.env,
    PATH: [bin, process.env.PATH].join(delimiter),
    GIT_DIR: '/not/a/repository',
  });
  assert.deepEqual(state, { aposCommit: sha, dirty: false });
});

it('removes arbitrary inherited directories inside node_modules, including symlink aliases', async () => {
  const { symlinkSync } = await import('node:fs');
  const { isolatedPath } = await import('./env.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'bench-node-path-')),
    hidden = join(temp, 'node_modules', 'tools'),
    alias = join(temp, 'alias');
  mkdirSync(hidden, { recursive: true });
  symlinkSync(hidden, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const safe = join(temp, 'safe');
  mkdirSync(safe);
  assert.equal(isolatedPath([hidden, alias, safe].join(delimiter)), safe);
});

it('removes inherited Node preloads from subprocess metadata checks', async () => {
  const { gitEnvironment } = await import('./env.mjs');
  const env = gitEnvironment({ PATH: '/usr/bin', NODE_PATH: '/outside', NODE_OPTIONS: '--require outside' });
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

it('preserves a mixed-case Windows PATH key while removing inherited Git overrides', async () => {
  const { gitEnvironment } = await import('./env.mjs');
  const safe = process.cwd();
  const env = gitEnvironment({ Path: safe, git_dir: '/spoof', Node_Options: '--require injected' });
  assert.equal(env.PATH, safe);
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1);
  assert.equal(env.git_dir, undefined);
  assert.equal(env.Node_Options, undefined);
});
