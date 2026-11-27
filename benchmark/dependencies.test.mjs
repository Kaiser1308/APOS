import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareCaseDependencies } from './dependencies.mjs';

const linuxIt = (name, fn) =>
  it(name, { skip: process.platform !== 'linux' && 'benchmark execution requires Linux' }, fn);

linuxIt('installs the case lock in an isolated seed and gives APOS worktrees the case dependency', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-seed-')),
    repo = join(dir, 'repo');
  mkdirSync(repo);
  mkdirSync(join(repo, 'vendor', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'vendor', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.2.3' }));
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { dep: 'file:vendor/dep' } }),
  );
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], {
    cwd: repo,
    stdio: 'ignore',
  });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'add', '.gitignore', 'package.json', 'package-lock.json', 'vendor']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const work = join(dir, 'work');
  mkdirSync(work);
  const cache = prepareCaseDependencies(repo, [commit], work, process.env);
  assert.equal(existsSync(join(repo, 'node_modules')), false);
  assert.equal(
    JSON.parse(readFileSync(join(work, 'dependency-seeds', '0', 'node_modules', 'dep', 'package.json'), 'utf8'))
      .version,
    '1.2.3',
  );
  const { GitWorktreeFactory } = await import('../dist/app/gate-workspace.js');
  const oldCache = process.env.npm_config_cache,
    oldOffline = process.env.npm_config_offline;
  process.env.npm_config_cache = cache;
  process.env.npm_config_offline = 'true';
  let workspace;
  try {
    workspace = new GitWorktreeFactory().checkout(repo, commit);
    assert.match(workspace.preparation, /npm ci .* exit 0/);
    assert.equal(
      JSON.parse(readFileSync(join(workspace.path, 'node_modules', 'dep', 'package.json'), 'utf8')).version,
      '1.2.3',
    );
  } finally {
    workspace?.dispose();
    if (oldCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = oldCache;
    if (oldOffline === undefined) delete process.env.npm_config_offline;
    else process.env.npm_config_offline = oldOffline;
  }
});

linuxIt('rejects a Node case whose lockfile does not match its manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-bad-lock-')),
    repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'bad', version: '1.0.0', dependencies: { missing: '1.0.0' } }),
  );
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: 'bad', lockfileVersion: 3, packages: {} }));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'add', 'package.json', 'package-lock.json']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const work = join(dir, 'work');
  mkdirSync(work);
  assert.throws(() => prepareCaseDependencies(repo, [commit], work, { ...process.env, npm_config_offline: 'true' }));
});

linuxIt('rejects a snapshot with a committed node_modules link before installation', async () => {
  const { symlinkSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-committed-link-')),
    repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  writeFileSync(
    join(repo, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: {} }),
  );
  symlinkSync(dir, join(repo, 'node_modules'), 'dir');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'add', 'package.json', 'package-lock.json', 'node_modules']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const work = join(dir, 'work');
  mkdirSync(work);
  assert.throws(() => prepareCaseDependencies(repo, [commit], work, process.env), /must not contain node_modules/);
});

it('rejects a gate with a failed dependency install even when a tool later reports success', async () => {
  const { assertInstallationsSucceeded } = await import('./dependencies.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-install-log-'));
  writeFileSync(
    join(dir, 'gate.log'),
    '# dependencies: npm ci --no-audit --no-fund (reason) exit 1 in 1s\n# end of dependency install\n',
  );
  assert.throws(() => assertInstallationsSucceeded(dir));
  writeFileSync(join(dir, 'gate.log'), '# dependencies: npm ci --no-audit --no-fund (reason) exit 0 in 1s\n');
  assert.doesNotThrow(() => assertInstallationsSucceeded(dir));
});

linuxIt('rejects local dependency links escaping the snapshot before npm can run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-escape-')),
    repo = join(dir, 'repo'),
    outside = join(dir, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'outside', version: '1.0.0' }));
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { outside: 'file:../outside' } }),
  );
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {
    cwd: repo,
    stdio: 'ignore',
  });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'add', 'package.json', 'package-lock.json']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const work = join(dir, 'work');
  mkdirSync(work);
  assert.throws(() => prepareCaseDependencies(repo, [sha], work, process.env), /outside the snapshot/);
});

it('rejects an unresolved workspace link instead of treating it as an ordinary dependency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-invalid-link-')),
    repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  writeFileSync(
    join(repo, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: '1.0.0' }, 'node_modules/dep': { link: true } },
    }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'add', 'package.json', 'package-lock.json']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    work = join(dir, 'work');
  mkdirSync(work);
  assert.throws(() => prepareCaseDependencies(repo, [sha], work, process.env), /unresolved local dependency/);
});

linuxIt('rejects a lockfile symlink instead of reading dependencies outside the snapshot', async () => {
  const { symlinkSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-lock-link-')),
    repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  writeFileSync(
    join(dir, 'outside-lock.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    }),
  );
  symlinkSync(join(dir, 'outside-lock.json'), join(repo, 'package-lock.json'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'add', 'package.json', 'package-lock.json']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    work = join(dir, 'work');
  mkdirSync(work);
  assert.throws(() => prepareCaseDependencies(repo, [sha], work, process.env), /regular files/);
});
