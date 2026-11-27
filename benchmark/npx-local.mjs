#!/usr/bin/env node
// Run only binaries installed inside this case's Git worktree; never download via npx.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--no-install' || args[0] === '--no') args.shift();
const name = args.shift();
if (!name || name === '.' || name === '..' || name.startsWith('-') || name !== basename(name) || name.includes('@')) {
  process.stderr.write('benchmark: npx requires a local executable name\n');
  process.exit(1);
}
let root;
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  root = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', env }).trim());
} catch {
  process.stderr.write('benchmark: npx requires a case worktree\n');
  process.exit(1);
}
let dir = realpathSync(process.cwd());
while (
  dir === root ||
  (relative(root, dir) !== '..' && !relative(root, dir).startsWith(`..${sep}`) && !isAbsolute(relative(root, dir)))
) {
  const candidate = join(dir, 'node_modules', '.bin', name);
  if (existsSync(candidate)) {
    const target = realpathSync(candidate);
    const inside = relative(root, target);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) break;
    const done = spawnSync(candidate, args, { stdio: 'inherit' });
    process.exit(done.status ?? 1);
  }
  if (dir === root) break;
  dir = dirname(dir);
}
process.stderr.write('benchmark: npx executable is not installed in this case\n');
process.exit(1);
