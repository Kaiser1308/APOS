import { it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('runs a case-local executable and refuses a missing or external one', () => {
  const temp = mkdtempSync(join(tmpdir(), 'bench-npx-wrapper-'));
  const dir = join(temp, 'repo');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', dir]);
  const bin = join(dir, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const tool = join(bin, 'fixture');
  writeFileSync(tool, '#!/bin/sh\nprintf local-case\n');
  chmodSync(tool, 0o700);
  const external = join(temp, 'outside-tool');
  writeFileSync(external, '#!/bin/sh\nexit 0\n');
  chmodSync(external, 0o700);
  symlinkSync(external, join(bin, 'escape'));
  const wrapper = resolve('benchmark/npx-local.mjs');
  const run = name => spawnSync(process.execPath, [wrapper, name], { cwd: dir, encoding: 'utf8' });
  assert.equal(run('fixture').stdout, 'local-case');
  assert.notEqual(run('missing').status, 0);
  assert.notEqual(run('escape').status, 0);
});
