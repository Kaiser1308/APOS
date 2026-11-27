import { it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
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

it('keeps execution diagnostics private when a case cannot start', async () => {
  const { runSafely } = await import('./run-case.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-private-error-'));
  const work = join(dir, 'run');
  assert.throws(
    () =>
      runSafely(
        {
          id: 'private-id',
          repository: 'missing.bundle',
          deliveryCommit: 'a'.repeat(40),
          actions: [],
          goalId: 'G',
          packageId: 'W',
        },
        dir,
        resolve('dist/cli.js'),
        work,
      ),
    error => error.message === 'Benchmark case failed; inspect the private output directory',
  );
  assert.equal(existsSync(join(dir, 'run.failure.txt')), true);
});

it('keeps the APOS dependency tree untouched when a case runs npm ci with its own lockfile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-deps-'));
  const source = join(dir, 'source');
  const apos = join(dir, 'apos');
  mkdirSync(source);
  mkdirSync(join(apos, 'dist'), { recursive: true });
  mkdirSync(join(apos, 'node_modules', 'sentinel'), { recursive: true });
  const sentinel = join(apos, 'node_modules', 'sentinel', 'keep.txt');
  writeFileSync(sentinel, 'keep');
  mkdirSync(join(source, 'vendor', 'case-dep'), { recursive: true });
  writeFileSync(
    join(source, 'vendor', 'case-dep', 'package.json'),
    JSON.stringify({ name: 'case-dep', version: '1.2.3' }),
  );
  const manifest = { name: 'fixture', version: '1.0.0', dependencies: { 'case-dep': 'file:vendor/case-dep' } };
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], {
    cwd: source,
    stdio: 'ignore',
  });
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  execFileSync('git', ['-C', source, 'add', 'package.json', 'package-lock.json', '.gitignore', 'vendor']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', source, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
  const fake = join(apos, 'dist', 'cli.cjs');
  writeFileSync(
    fake,
    "const {spawnSync}=require('node:child_process'); const fs=require('node:fs'); const repo=process.argv[3]; if(process.argv[4]==='init'){const r=spawnSync('npm',['ci','--ignore-scripts','--no-audit','--no-fund','--offline'],{cwd:repo}); if(r.status!==0)process.exit(2); fs.writeFileSync(require('node:path').join(repo,'ci-ran'),require(require('node:path').join(repo,'node_modules','case-dep','package.json')).version);} else process.exit(1);",
  );
  const work = join(dir, 'run');
  assert.throws(() =>
    runCase(
      { id: 'x', repository: 'repo.bundle', deliveryCommit: sha, actions: [['init']], goalId: 'G', packageId: 'W' },
      dir,
      fake,
      work,
    ),
  );
  assert.equal(existsSync(join(work, 'repo', 'ci-ran')), true);
  assert.equal(readFileSync(join(work, 'repo', 'ci-ran'), 'utf8'), '1.2.3');
  assert.equal(existsSync(sentinel), true);
});

it('does not pass APOS node_modules binaries or NODE_PATH into a case process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-path-env-'));
  const source = join(dir, 'source'),
    apos = join(dir, 'apos');
  mkdirSync(source);
  mkdirSync(join(apos, 'dist'), { recursive: true });
  mkdirSync(join(apos, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(source, 'data'), 'x');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  execFileSync('git', ['-C', source, 'add', 'data']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', source, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
  const fake = join(apos, 'dist', 'cli.cjs');
  writeFileSync(
    fake,
    "const fs=require('node:fs'),p=require('node:path');if(process.argv[4]==='init')fs.writeFileSync(p.join(process.argv[3],'env.json'),JSON.stringify({path:process.env.PATH,nodePath:process.env.NODE_PATH}));else process.exit(1);",
  );
  const originalPath = process.env.PATH,
    originalNodePath = process.env.NODE_PATH,
    sourceBin = join(apos, 'node_modules', '.bin');
  process.env.PATH = `${sourceBin}:${originalPath}`;
  process.env.NODE_PATH = join(apos, 'node_modules');
  try {
    assert.throws(() =>
      runCase(
        { id: 'x', repository: 'repo.bundle', deliveryCommit: sha, actions: [['init']], goalId: 'G', packageId: 'W' },
        dir,
        fake,
        join(dir, 'run'),
      ),
    );
    const env = JSON.parse(readFileSync(join(dir, 'run', 'repo', 'env.json'), 'utf8'));
    assert.equal(env.path.split(':').includes(sourceBin), false);
    assert.equal(env.nodePath, undefined);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = originalNodePath;
  }
});

it('does not let npx fall back to an undeclared tool cached outside the case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-npx-isolation-'));
  const source = join(dir, 'source'),
    apos = join(dir, 'apos');
  mkdirSync(source);
  mkdirSync(join(apos, 'dist'), { recursive: true });
  writeFileSync(join(source, 'data'), 'x');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  execFileSync('git', ['-C', source, 'add', 'data']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', source, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
  const fake = join(apos, 'dist', 'cli.cjs');
  writeFileSync(
    fake,
    "const {spawnSync}=require('node:child_process'),fs=require('node:fs'),p=require('node:path');if(process.argv[4]==='init'){let r=spawnSync('npx',['vitest','--version'],{cwd:process.argv[3],stdio:'ignore'});fs.writeFileSync(p.join(process.argv[3],'npx-status'),String(r.status));}else process.exit(1);",
  );
  const work = join(dir, 'run');
  assert.throws(() =>
    runCase(
      { id: 'x', repository: 'repo.bundle', deliveryCommit: sha, actions: [['init']], goalId: 'G', packageId: 'W' },
      dir,
      fake,
      work,
    ),
  );
  assert.notEqual(readFileSync(join(work, 'repo', 'npx-status'), 'utf8'), '0');
});

it('routes npx through the case-local guard rather than an inherited executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-npx-route-')),
    source = join(dir, 'source'),
    apos = join(dir, 'apos'),
    globalBin = join(dir, 'global');
  mkdirSync(source);
  mkdirSync(join(apos, 'dist'), { recursive: true });
  mkdirSync(globalBin);
  writeFileSync(join(source, 'data'), 'x');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  execFileSync('git', ['-C', source, 'add', 'data']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', source, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
  const marker = join(dir, 'global-used'),
    globalNpx = join(globalBin, 'npx');
  writeFileSync(globalNpx, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  chmodSync(globalNpx, 0o700);
  const fake = join(apos, 'dist', 'cli.cjs');
  writeFileSync(
    fake,
    "const {spawnSync}=require('node:child_process'),fs=require('node:fs'),p=require('node:path');if(process.argv[4]==='init'){let r=spawnSync('npx',['missing-tool'],{cwd:process.argv[3],stdio:'ignore'});fs.writeFileSync(p.join(process.argv[3],'status'),String(r.status));}else process.exit(1);",
  );
  const before = process.env.PATH;
  process.env.PATH = `${globalBin}:${before}`;
  try {
    assert.throws(() =>
      runCase(
        { id: 'x', repository: 'repo.bundle', deliveryCommit: sha, actions: [['init']], goalId: 'G', packageId: 'W' },
        dir,
        fake,
        join(dir, 'run'),
      ),
    );
    assert.notEqual(readFileSync(join(dir, 'run', 'repo', 'status'), 'utf8'), '0');
    assert.equal(existsSync(marker), false);
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
});

it('does not invoke an inherited dependency-bin git while cloning a case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-git-route-')),
    source = join(dir, 'source'),
    apos = join(dir, 'apos');
  mkdirSync(source);
  mkdirSync(join(apos, 'dist'), { recursive: true });
  mkdirSync(join(apos, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(source, 'data'), 'x');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  execFileSync('git', ['-C', source, 'add', 'data']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', source, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
  const marker = join(dir, 'fake-git-used'),
    fakeGit = join(apos, 'node_modules', '.bin', 'git');
  writeFileSync(fakeGit, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(fakeGit, 0o700);
  const fake = join(apos, 'dist', 'cli.cjs');
  writeFileSync(
    fake,
    "const fs=require('node:fs'),p=require('node:path');if(process.argv[4]==='init')fs.writeFileSync(p.join(process.argv[3],'ran'),'yes');else process.exit(1);",
  );
  const before = process.env.PATH;
  process.env.PATH = `${join(apos, 'node_modules', '.bin')}:${before}`;
  try {
    assert.throws(() =>
      runCase(
        { id: 'x', repository: 'repo.bundle', deliveryCommit: sha, actions: [['init']], goalId: 'G', packageId: 'W' },
        dir,
        fake,
        join(dir, 'run'),
      ),
    );
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(dir, 'run', 'repo', 'ran')), true);
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
});

it('refuses unlocked npm installs during a case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-npm-route-')),
    source = join(dir, 'source'),
    apos = join(dir, 'apos');
  mkdirSync(source);
  mkdirSync(join(apos, 'dist'), { recursive: true });
  const manifest = { name: 'fixture', version: '1.0.0' };
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(
    join(source, 'package-lock.json'),
    JSON.stringify({ ...manifest, lockfileVersion: 3, packages: { '': manifest } }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  execFileSync('git', ['-C', source, 'add', 'package.json', 'package-lock.json']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', source, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
  const fake = join(apos, 'dist', 'cli.cjs');
  writeFileSync(
    fake,
    "const {spawnSync}=require('node:child_process'),fs=require('node:fs'),p=require('node:path');if(process.argv[4]==='init'){let r=spawnSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund'],{cwd:process.argv[3],stdio:'ignore'});fs.writeFileSync(p.join(process.argv[3],'status'),String(r.status));}else process.exit(1);",
  );
  assert.throws(() =>
    runCase(
      { id: 'x', repository: 'repo.bundle', deliveryCommit: sha, actions: [['init']], goalId: 'G', packageId: 'W' },
      dir,
      fake,
      join(dir, 'run'),
    ),
  );
  assert.notEqual(readFileSync(join(dir, 'run', 'repo', 'status'), 'utf8'), '0');
});

it('does not let uppercase npm configuration bypass the isolated cache and offline gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-npm-env-')),
    source = join(dir, 'source'),
    apos = join(dir, 'apos');
  mkdirSync(source);
  mkdirSync(join(apos, 'dist'), { recursive: true });
  writeFileSync(join(source, 'data'), 'x');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  execFileSync('git', ['-C', source, 'add', 'data']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', source, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
  const fake = join(apos, 'dist', 'cli.cjs');
  writeFileSync(
    fake,
    "const fs=require('node:fs'),p=require('node:path');if(process.argv[4]==='init')fs.writeFileSync(p.join(process.argv[3],'npm-env.json'),JSON.stringify({upperCache:process.env.NPM_CONFIG_CACHE,upperOffline:process.env.NPM_CONFIG_OFFLINE,cache:process.env.npm_config_cache,offline:process.env.npm_config_offline}));else process.exit(1);",
  );
  const beforeCache = process.env.NPM_CONFIG_CACHE,
    beforeOffline = process.env.NPM_CONFIG_OFFLINE;
  process.env.NPM_CONFIG_CACHE = join(dir, 'outside-cache');
  process.env.NPM_CONFIG_OFFLINE = 'false';
  try {
    assert.throws(() =>
      runCase(
        { id: 'x', repository: 'repo.bundle', deliveryCommit: sha, actions: [['init']], goalId: 'G', packageId: 'W' },
        dir,
        fake,
        join(dir, 'run'),
      ),
    );
    const env = JSON.parse(readFileSync(join(dir, 'run', 'repo', 'npm-env.json'), 'utf8'));
    assert.equal(env.upperCache, undefined);
    assert.equal(env.upperOffline, undefined);
    assert.equal(env.cache, join(dir, 'run', 'npm-cache'));
    assert.equal(env.offline, 'true');
  } finally {
    if (beforeCache === undefined) delete process.env.NPM_CONFIG_CACHE;
    else process.env.NPM_CONFIG_CACHE = beforeCache;
    if (beforeOffline === undefined) delete process.env.NPM_CONFIG_OFFLINE;
    else process.env.NPM_CONFIG_OFFLINE = beforeOffline;
  }
});

it('refuses an npm executable that resolves into the APOS checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-npm-alias-')),
    source = join(dir, 'source'),
    apos = join(dir, 'apos'),
    globalBin = join(dir, 'global');
  mkdirSync(source);
  mkdirSync(join(apos, 'dist'), { recursive: true });
  mkdirSync(join(apos, 'node_modules', 'npm'), { recursive: true });
  mkdirSync(globalBin);
  writeFileSync(join(source, 'data'), 'x');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  execFileSync('git', ['-C', source, 'add', 'data']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', source, 'bundle', 'create', join(dir, 'repo.bundle'), '--all']);
  const fakeNpm = join(apos, 'node_modules', 'npm', 'cli');
  writeFileSync(fakeNpm, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeNpm, 0o700);
  symlinkSync(fakeNpm, join(globalBin, 'npm'));
  const fake = join(apos, 'dist', 'cli.cjs');
  writeFileSync(fake, 'process.exit(1)');
  const before = process.env.PATH;
  process.env.PATH = `${globalBin}:${before}`;
  try {
    assert.throws(
      () =>
        runCase(
          { id: 'x', repository: 'repo.bundle', deliveryCommit: sha, actions: [], goalId: 'G', packageId: 'W' },
          dir,
          fake,
          join(dir, 'run'),
        ),
      /npm executable is inside the APOS checkout/,
    );
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
});
