import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const script = fileURLToPath(new URL('./promote-skills.mjs', import.meta.url));
const bundled = fileURLToPath(new URL('../skills', import.meta.url));
const run = (...args: string[]) => {
  try { return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }) }; }
  catch (error) { const failure = error as { status: number; stdout: string }; return { code: failure.status, out: failure.stdout }; }
};
const copyOfStable = () => { const dir = mkdtempSync(join(tmpdir(), 'apos-skills-')); dirs.push(dir); cpSync(bundled, dir, { recursive: true }); return dir; };

it('reports drift without writing, and brings the development copy over only when asked', () => {
  const dev = copyOfStable();
  const stable = copyOfStable();
  expect(run('--check', '--to', stable, dev)).toMatchObject({ code: 0 });
  const edited = join(dev, 'apos-lead', 'SKILL.md');
  writeFileSync(edited, `${readFileSync(edited, 'utf8')}\nan edit made only in the development copy\n`);
  const checked = run('--check', '--to', stable, dev);
  expect(checked.code).toBe(1);
  expect(checked.out).toMatch(/differs\s+apos-lead/);
  expect(readFileSync(join(stable, 'apos-lead', 'SKILL.md'), 'utf8')).not.toMatch(/only in the development copy/);
  expect(run('--to', stable, dev).code).toBe(0);
  expect(readFileSync(join(stable, 'apos-lead', 'SKILL.md'), 'utf8')).toMatch(/only in the development copy/);
  expect(run('--check', '--to', stable, dev)).toMatchObject({ code: 0 });
});

it('takes the development dir as the first argument when no --to is given', () => {
  const dev = copyOfStable();
  const result = run("--check", dev); // the real stable copy, read only
  expect(result.out).toMatch(/same {2,}apos-core/);
});

it('refuses a development skill that does not declare the contract version', () => {
  const dev = copyOfStable();
  const stable = copyOfStable();
  const file = join(dev, 'apos-pm', 'SKILL.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^apos-contract:.*\r?\n/m, ''));
  expect(run('--to', stable, dev).code).toBe(1);
});

it('--check without a development copy validates the bundled skills instead of crashing (GitHub #10)', () => {
  const env = { ...process.env }; delete env.APOS_DEV_SKILLS;
  const check = (stable: string) => { try { return { code: 0, out: execFileSync(process.execPath, [script, '--check', '--to', stable], { encoding: 'utf8', env }) }; } catch (error) { const failure = error as { status: number; stdout: string }; return { code: failure.status, out: failure.stdout }; } };
  const stable = copyOfStable();
  expect(check(stable)).toMatchObject({ code: 0, out: expect.stringMatching(/bundled skills OK/) });
  const broken = join(stable, 'apos-lead', 'SKILL.md');
  writeFileSync(broken, readFileSync(broken, 'utf8').replace(/^apos-contract:.*$/m, ''));
  expect(check(stable).code).toBe(1);
});
