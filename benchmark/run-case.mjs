import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { attachResultDigest, readGateResult } from './result.mjs';
import { assertInstallationsSucceeded, prepareCaseDependencies } from './dependencies.mjs';
import { isolatedPath } from './env.mjs';

export function runCase(item, corpus, cli, work) {
  mkdirSync(work, { recursive: false, mode: 0o700 });
  const repo = join(work, 'repo');
  const home = join(work, 'home');
  const artifacts = join(work, 'artifacts');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(artifacts, { mode: 0o700 });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    APOS_HOME: home,
    APOS_ARTIFACTS: artifacts,
    NODE_NO_WARNINGS: '1',
  };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const requestedOffline = Object.entries(env).some(
    ([key, value]) => key.toLowerCase() === 'npm_config_offline' && /^(true|1)$/i.test(value ?? ''),
  );
  for (const key of Object.keys(env)) {
    if (['npm_config_cache', 'npm_config_offline', 'npm_config_yes'].includes(key.toLowerCase())) delete env[key];
  }
  if (requestedOffline) env.npm_config_offline = 'true';
  const bin = join(work, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  const npx = join(bin, 'npx');
  copyFileSync(fileURLToPath(new URL('./npx-local.mjs', import.meta.url)), npx);
  chmodSync(npx, 0o700);
  env.PATH = isolatedPath(env.PATH);
  const npmLookup = spawnSync('sh', ['-c', 'command -v npm'], { env, encoding: 'utf8' });
  if (npmLookup.status !== 0) throw new Error('npm is not available outside inherited dependency bins');
  env.APOS_BENCH_REAL_NPM = realpathSync(npmLookup.stdout.trim());
  const npmFromApos = relative(realpathSync(dirname(dirname(cli))), env.APOS_BENCH_REAL_NPM);
  if (npmFromApos !== '..' && !npmFromApos.startsWith(`..${sep}`) && !isAbsolute(npmFromApos)) {
    throw new Error('npm executable is inside the APOS checkout');
  }
  const npm = join(bin, 'npm');
  copyFileSync(fileURLToPath(new URL('./npm-local.mjs', import.meta.url)), npm);
  chmodSync(npm, 0o700);
  env.PATH = `${bin}${delimiter}${env.PATH}`;
  execFileSync('git', ['clone', '-q', '--no-hardlinks', join(corpus, item.repository), repo], { env, stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'cat-file', '-e', `${item.deliveryCommit}^{commit}`], { env, stdio: 'ignore' });
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
  const commits = [head, item.deliveryCommit, ...(item.dependencyCommits ?? [])];
  for (const action of item.actions) {
    for (let index = 0; index < action.length - 1; index++) {
      if (['--commit', '--base', '@checkout'].includes(action[index]) && /^[a-f0-9]{40}$/.test(action[index + 1]))
        commits.push(action[index + 1]);
    }
  }
  env.npm_config_cache = prepareCaseDependencies(repo, commits, work, env);
  env.npm_config_offline = 'true';
  env.npm_config_yes = 'false';
  if (item.clock) env.APOS_NOW = item.clock;
  else delete env.APOS_NOW;
  const expand = arg =>
    arg.replaceAll('{corpus}', corpus).replaceAll('{repo}', repo).replaceAll('{delivery}', item.deliveryCommit);
  const args = argv => [cli, '--repo', repo, ...argv.map(expand)];
  for (const action of item.actions) {
    if (action[0] === '@checkout') {
      if (action.length !== 2 || !/^[a-f0-9]{40}$/.test(action[1])) throw new Error('checkout needs a full commit');
      execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach', action[1]], { env, stdio: 'ignore' });
      continue;
    }
    const step = spawnSync(process.execPath, args(action), { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (step.status !== 0) {
      writeFileSync(join(work, 'preparation-error.txt'), step.stdout + step.stderr, { mode: 0o600 });
      throw new Error('APOS preparation failed; no verdict recorded');
    }
  }
  const timeFile = join(work, 'time.txt');
  const started = performance.now();
  const result = spawnSync(
    '/usr/bin/time',
    [
      '-o',
      timeFile,
      '-f',
      '%U %S %M',
      process.execPath,
      ...args(['package', 'submit', item.goalId, item.packageId, '--commit', item.deliveryCommit, '--json']),
    ],
    { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const captured = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(work, 'gate-output.txt'), captured, { mode: 0o600 });
  assertInstallationsSucceeded(artifacts);
  const duration = performance.now() - started;
  const [userCpuSeconds, systemCpuSeconds, maxRssKb] = readFileSync(timeFile, 'utf8')
    .trim()
    .split('\n')
    .at(-1)
    .split(' ')
    .map(Number);
  if (![userCpuSeconds, systemCpuSeconds, maxRssKb].every(Number.isFinite))
    throw new Error('Could not measure gate resources');
  return {
    ...attachResultDigest(
      readGateResult(result.stdout, result.status, {
        goalId: item.goalId,
        packageId: item.packageId,
        commit: item.deliveryCommit,
      }),
      createHash('sha256').update(captured).digest('hex'),
    ),
    durationMs: duration,
    userCpuSeconds,
    systemCpuSeconds,
    maxRssKb,
  };
}

export function runSafely(item, corpus, cli, work) {
  try {
    return runCase(item, corpus, cli, work);
  } catch (error) {
    writeFileSync(`${work}.failure.txt`, error instanceof Error ? (error.stack ?? error.message) : String(error), {
      mode: 0o600,
      flag: 'wx',
    });
    throw new Error('Benchmark case failed; inspect the private output directory');
  }
}
