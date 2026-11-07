import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initProject } from './init-project.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
it('initializes a managed Git project twice without losing the first state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-init-')); dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  await initProject(dir);
  expect(existsSync(join(dir, '.apos', 'project.yaml'))).toBe(true);
  expect(existsSync(join(dir, '.apos', 'goals'))).toBe(true);
  expect(existsSync(join(dir, '.claude', 'skills', 'apos-pm', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(dir, '.claude', 'skills', 'apos-lead', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(dir, '.claude', 'skills', 'apos-worker', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(dir, '.claude', 'skills', 'apos-reviewer', 'SKILL.md'))).toBe(true);
  const committed = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
  expect(committed).toContain('.apos/project.yaml');
  expect(committed).toContain('.claude/skills/apos-worker/SKILL.md');
  expect(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('1');
});
