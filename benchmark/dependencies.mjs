import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const lockSchema = z.object({
  lockfileVersion: z.number().min(2),
  packages: z.record(
    z.string(),
    z.object({ resolved: z.string().optional(), link: z.boolean().optional() }).passthrough(),
  ),
});

function assertLocalDependencies(seed) {
  let lock;
  try {
    lock = lockSchema.parse(JSON.parse(readFileSync(join(seed, 'package-lock.json'), 'utf8')));
  } catch {
    throw new Error('case lockfile is invalid or lacks package metadata');
  }
  const root = realpathSync(seed);
  for (const item of Object.values(lock.packages)) {
    const spec = item.resolved;
    if (item.link && !spec) throw new Error('unresolved local dependency in case lockfile');
    if (!spec || (!spec.startsWith('file:') && !item.link)) continue;
    let path;
    try {
      const value = decodeURIComponent(spec.startsWith('file:') ? spec.slice(5) : spec);
      if (isAbsolute(value)) throw new Error('absolute path');
      path = realpathSync(resolve(root, value));
    } catch {
      throw new Error('local dependency is missing or outside the snapshot');
    }
    const fromRoot = relative(root, path);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      throw new Error('local dependency is outside the snapshot');
    }
  }
}

/** Seed a case-local npm cache from each fixed snapshot, never from APOS's installed modules. */
export function prepareCaseDependencies(repo, commits, work, baseEnv) {
  const cache = join(work, 'npm-cache');
  const seeds = join(work, 'dependency-seeds');
  mkdirSync(cache, { mode: 0o700 });
  mkdirSync(seeds, { mode: 0o700 });
  for (const [index, commit] of [...new Set(commits)].entries()) {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`], { env: baseEnv, stdio: 'ignore' });
    const listing = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '--name-only', commit], {
      encoding: 'utf8',
      env: baseEnv,
    }).split('\0');
    if (listing.some(path => path.split('/').includes('node_modules'))) {
      throw new Error('case snapshots must not contain node_modules');
    }
    if (!listing.includes('package.json')) continue;
    if (!listing.includes('package-lock.json')) throw new Error('case Node snapshot requires a package-lock.json');
    const seed = join(seeds, String(index));
    execFileSync('git', ['clone', '-q', '--no-hardlinks', '--no-checkout', repo, seed], {
      env: baseEnv,
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', seed, 'checkout', '-q', '--detach', commit], { env: baseEnv, stdio: 'ignore' });
    if (existsSync(join(seed, 'node_modules'))) throw new Error('case snapshot contains node_modules');
    if (!['package.json', 'package-lock.json'].every(file => lstatSync(join(seed, file)).isFile())) {
      throw new Error('case package manifest and lockfile must be regular files');
    }
    assertLocalDependencies(seed);
    const install = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: seed,
      encoding: 'utf8',
      env: { ...baseEnv, npm_config_cache: cache },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    });
    writeFileSync(join(seeds, `${index}.log`), (install.stdout ?? '') + (install.stderr ?? ''), { mode: 0o600 });
    if (install.status !== 0) throw new Error('case dependency installation failed');
  }
  return cache;
}

export function assertInstallationsSucceeded(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) assertInstallationsSucceeded(path);
    else if (entry.isFile() && entry.name.endsWith('.log')) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/^# dependencies: npm ci .*? exit (\S+)([^\n]*)/gm)) {
        if (match[1] !== '0' || match[2].includes('timed out')) throw new Error('case dependency installation failed');
      }
    }
  }
}
