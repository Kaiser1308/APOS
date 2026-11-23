import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initProject } from './init-project.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
it('initializes a managed Git project twice without losing the first state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-init-'));
  dirs.push(dir);
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

it('refuses skills that are missing or written for another APOS contract', async () => {
  const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf, cpSync, rmSync: rm } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  const { resolveSkills, BUNDLED_SKILLS } = await import('./init-project.js');
  expect(resolveSkills().core).toMatch(/skills[\\/]apos-core/);
  const root = mk(j(tmp(), 'apos-skills-'));
  cpSync(BUNDLED_SKILLS, root, { recursive: true });
  expect(resolveSkills(root).roles.lead).toMatch(/apos-lead/);
  wf(j(root, 'apos-lead', 'SKILL.md'), ['---', 'name: apos-lead', 'apos-contract: 1', '---', 'old'].join('\n'));
  expect(() => resolveSkills(root)).toThrow(/declares apos-contract 1; this APOS build needs 3/);
  rm(j(root, 'apos-worker'), { recursive: true });
  md(j(root, 'apos-lead'), { recursive: true });
  expect(() => resolveSkills(root)).toThrow(/apos-contract 1|APOS skill missing/);
  rm(root, { recursive: true, force: true });
});

it('installs the role skills where Codex and Antigravity read them too, without overwriting a local copy', async () => {
  const { readFileSync, mkdirSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'apos-init-agents-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, '.agents', 'skills', 'apos-lead'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'skills', 'apos-lead', 'SKILL.md'), 'my own lead skill');
  await initProject(dir);
  for (const role of ['pm', 'worker', 'reviewer', 'tester']) {
    expect(readFileSync(join(dir, '.agents', 'skills', `apos-${role}`, 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(dir, '.claude', 'skills', `apos-${role}`, 'SKILL.md'), 'utf8'),
    );
  }
  expect(readFileSync(join(dir, '.agents', 'skills', 'apos-lead', 'SKILL.md'), 'utf8')).toBe('my own lead skill');
  const committed = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
  expect(committed).toContain('.agents/skills/apos-pm/SKILL.md');
  expect(committed).toContain('.apos/skills/tester.md');
  expect(committed).not.toContain('.agents/skills/apos-lead/SKILL.md');
});
