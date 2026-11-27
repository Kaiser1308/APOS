import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readGateResult } from './result.mjs';

export function runCase(item, corpus, cli, work) {
  mkdirSync(work, { recursive: false, mode: 0o700 });
  const repo = join(work, 'repo');
  const home = join(work, 'home');
  const artifacts = join(work, 'artifacts');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(artifacts, { mode: 0o700 });
  execFileSync('git', ['clone', '-q', '--no-hardlinks', join(corpus, item.repository), repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'cat-file', '-e', `${item.deliveryCommit}^{commit}`], { stdio: 'ignore' });
  symlinkSync(join(dirname(dirname(cli)), 'node_modules'), join(repo, 'node_modules'), 'dir');
  const env = { ...process.env, APOS_HOME: home, APOS_ARTIFACTS: artifacts, NODE_NO_WARNINGS: '1' };
  if (item.clock) env.APOS_NOW = item.clock;
  else delete env.APOS_NOW;
  const expand = arg =>
    arg.replaceAll('{corpus}', corpus).replaceAll('{repo}', repo).replaceAll('{delivery}', item.deliveryCommit);
  const args = argv => [cli, '--repo', repo, ...argv.map(expand)];
  for (const action of item.actions) {
    if (action[0] === '@checkout') {
      if (action.length !== 2 || !/^[a-f0-9]{40}$/.test(action[1])) throw new Error('checkout needs a full commit');
      execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach', action[1]], { stdio: 'ignore' });
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
  writeFileSync(join(work, 'gate-output.txt'), (result.stdout ?? '') + (result.stderr ?? ''), { mode: 0o600 });
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
    ...readGateResult(result.stdout, result.status, {
      goalId: item.goalId,
      packageId: item.packageId,
      commit: item.deliveryCommit,
    }),
    durationMs: duration,
    userCpuSeconds,
    systemCpuSeconds,
    maxRssKb,
  };
}
