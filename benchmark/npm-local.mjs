#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0];
if (command === 'exec' || command === 'x') {
  args.shift();
  if (args[0] === '--') args.shift();
  const done = spawnSync(join(dirname(process.argv[1]), 'npx'), args, { stdio: 'inherit' });
  process.exit(done.status ?? 1);
}
if (
  !['ci', 'run', 'run-script', 'test', 't', '--version', '-v'].includes(command) ||
  !process.env.APOS_BENCH_REAL_NPM
) {
  process.stderr.write('benchmark: npm command may change or fetch unlocked dependencies\n');
  process.exit(1);
}
const done = spawnSync(process.env.APOS_BENCH_REAL_NPM, args, { stdio: 'inherit' });
process.exit(done.status ?? 1);
