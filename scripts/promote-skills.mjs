#!/usr/bin/env node
// Bring the APOS skills from their development copy into the stable copy bundled with this repo.
//   node scripts/promote-skills.mjs --check <dev skills dir>   report differences, change nothing
//   node scripts/promote-skills.mjs <dev skills dir>           copy <dev>/apos-* over ./skills
// The development copy lives in the Custom-Skills repo; it defaults to $APOS_DEV_SKILLS. `--to <dir>`
// overrides the stable copy (default ./skills), mainly for tests. Nothing is committed or pushed:
// run the tests, then commit the result here when the skills are ready.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMES = ['apos-core', 'apos-pm', 'apos-lead', 'apos-worker', 'apos-reviewer', 'apos-tester'];
const args = process.argv.slice(2);
const check = args.includes('--check');
const toIndex = args.indexOf('--to');
const stable = toIndex >= 0 ? args[toIndex + 1] : fileURLToPath(new URL('../skills', import.meta.url));
const positional = args.filter((arg, index) => !arg.startsWith('--') && (toIndex < 0 || index !== toIndex + 1));
const dev = positional[0] ?? process.env.APOS_DEV_SKILLS;
if (check && !dev && stable) {
  // No development copy to compare with (the usual case for `npm run skills:check`): make sure the bundled skills are intact.
  const broken = NAMES.filter(name => {
    const file = join(stable, name, 'SKILL.md');
    return !existsSync(file) || !/^apos-contract:\s*\d+\s*$/m.test(readFileSync(file, 'utf8'));
  });
  for (const name of broken) console.error(`bundled skill ${name} is missing or does not declare apos-contract`);
  console.log(
    broken.length
      ? `${broken.length} bundled skill(s) are broken`
      : 'bundled skills OK (set APOS_DEV_SKILLS or pass a folder to compare with a development copy)',
  );
  process.exit(broken.length ? 1 : 0);
}
if (!dev || !stable) {
  console.error('Usage: promote-skills [--check] [--to <stable dir>] <dev skills dir>  (or set APOS_DEV_SKILLS)');
  process.exit(2);
}

const normal = text => text.replace(/\r\n/g, '\n');
let different = 0;
for (const name of NAMES) {
  const from = join(dev, name, 'SKILL.md');
  const to = join(stable, name, 'SKILL.md');
  if (!existsSync(from)) {
    console.error(`missing development skill: ${from}`);
    process.exit(1);
  }
  const source = readFileSync(from, 'utf8');
  if (!/^apos-contract:\s*\d+\s*$/m.test(source)) {
    console.error(`${from} does not declare apos-contract`);
    process.exit(1);
  }
  const current = existsSync(to) ? readFileSync(to, 'utf8') : undefined;
  const state = current === undefined ? 'new' : normal(current) === normal(source) ? 'same' : 'differs';
  console.log(`${state.padEnd(7)} ${name}`);
  if (state === 'same') continue;
  different += 1;
  if (!check) {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, source, 'utf8');
  }
}
console.log(
  check
    ? different
      ? `${different} skill(s) in the development copy differ from the stable copy`
      : 'stable copy is up to date'
    : `promoted ${different} skill(s) into ${stable}; run the tests, then commit`,
);
process.exit(check && different ? 1 : 0);
