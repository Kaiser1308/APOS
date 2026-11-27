import { it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const linuxIt = (name, fn) =>
  it(name, { skip: process.platform !== 'linux' && 'benchmark execution requires Linux' }, fn);

linuxIt('forwards npm ci, routes npm exec locally, and refuses dynamic installs', () => {
  const temp = mkdtempSync(join(tmpdir(), 'bench-npm-wrapper-')),
    repo = join(temp, 'repo'),
    bin = join(temp, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  execFileSync('git', ['init', '-q', repo]);
  for (const [name, source] of [
    ['npm', 'benchmark/npm-local.mjs'],
    ['npx', 'benchmark/npx-local.mjs'],
  ]) {
    const path = join(bin, name);
    copyFileSync(resolve(source), path);
    chmodSync(path, 0o700);
  }
  const real = join(temp, 'npm-real');
  writeFileSync(real, '#!/bin/sh\nprintf real-npm\n');
  chmodSync(real, 0o700);
  const local = join(repo, 'node_modules', '.bin');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'fixture'), '#!/bin/sh\nprintf local-case\n');
  chmodSync(join(local, 'fixture'), 0o700);
  const run = (...args) =>
    spawnSync(join(bin, 'npm'), args, {
      cwd: repo,
      env: { ...process.env, APOS_BENCH_REAL_NPM: real },
      encoding: 'utf8',
    });
  assert.equal(run('ci').stdout, 'real-npm');
  assert.equal(run('exec', '--', 'fixture').stdout, 'local-case');
  assert.notEqual(run('install', 'other').status, 0);
});
