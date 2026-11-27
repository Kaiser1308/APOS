import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCase } from './run-case.mjs';

it('does not invent a verdict when a real APOS command cannot submit a Goal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-test-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'file'), 'data');
  execFileSync('git', ['-C', repo, 'add', 'file']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const bundle = join(dir, 'repo.bundle');
  execFileSync('git', ['-C', repo, 'bundle', 'create', bundle, '--all']);
  assert.throws(() =>
    runCase(
      {
        id: 'test',
        repository: 'repo.bundle',
        deliveryCommit: sha,
        actions: [['init']],
        goalId: 'missing',
        packageId: 'WP-MAIN',
      },
      dir,
      resolve('dist/cli.js'),
      join(dir, 'run'),
    ),
  );
  assert.equal(existsSync(join(dir, 'run', 'gate-output.txt')), true);
});

it('can advance to a fixed commit between APOS preparation steps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-checkout-'));
  const repo = join(dir, 'source');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'file'), 'first');
  execFileSync('git', ['-C', repo, 'add', 'file']);
  const commit = () =>
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'test',
    ]);
  commit();
  const first = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'file'), 'second');
  execFileSync('git', ['-C', repo, 'add', 'file']);
  commit();
  const second = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', repo, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
  const work = join(dir, 'run');
  assert.throws(() =>
    runCase(
      {
        id: 'x',
        repository: 'repo.bundle',
        deliveryCommit: second,
        actions: [['@checkout', first], ['init']],
        goalId: 'missing',
        packageId: 'WP-MAIN',
      },
      dir,
      resolve('dist/cli.js'),
      work,
    ),
  );
  assert.equal(
    execFileSync('git', ['-C', join(work, 'repo'), 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim(),
    first,
  );
});
