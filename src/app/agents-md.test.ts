import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initProject } from './init-project.js';
import { upsertBlock } from './agents-md.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'apos-agentsmd-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.invalid']);
  return dir;
}
const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');
const count = (dir: string) =>
  execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
const BEGIN = '<!-- apos:begin (managed by `apos init`; edits inside are replaced) -->';
const END = '<!-- apos:end -->';

it('creates AGENTS.md with the block and CLAUDE.md pointing at it in an empty repo', async () => {
  const dir = repo();
  await initProject(dir);
  const agents = read(dir, 'AGENTS.md');
  expect(agents.startsWith(BEGIN)).toBe(true);
  expect(agents.trimEnd().endsWith(END)).toBe(true);
  for (const word of [
    'apos package submit',
    'apos inbox',
    '.apos/project.yaml',
    'docs/setup.md',
    'apos-worker',
    '--on-behalf',
  ])
    expect(agents).toContain(word);
  expect(read(dir, 'CLAUDE.md')).toBe('@AGENTS.md\n');
  const committed = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
  expect(committed).toContain('AGENTS.md');
  expect(committed).toContain('CLAUDE.md');
});

it('keeps the user text of AGENTS.md byte for byte and appends the block', async () => {
  const dir = repo();
  const mine = '# Mine\r\n\r\nrule one\r\n';
  writeFileSync(join(dir, 'AGENTS.md'), mine);
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
  await initProject(dir);
  const agents = read(dir, 'AGENTS.md');
  expect(agents.startsWith(mine)).toBe(true);
  expect(agents).toContain(BEGIN);
  expect(agents.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // CRLF throughout, no bare LF
});

it('replaces only the text between the markers of an older block', async () => {
  const dir = repo();
  const before = '# Mine\n\nkeep this\n\n';
  const after = '\nand this\n';
  writeFileSync(join(dir, 'AGENTS.md'), `${before}${BEGIN}\nold text\n${END}${after}`);
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
  await initProject(dir);
  const agents = read(dir, 'AGENTS.md');
  expect(agents.startsWith(before)).toBe(true);
  expect(agents.endsWith(after)).toBe(true);
  expect(agents).not.toContain('old text');
  expect(agents).toContain('apos package submit');
});

it('does not commit again when init runs a second time', async () => {
  const dir = repo();
  await initProject(dir);
  const first = count(dir);
  const text = read(dir, 'AGENTS.md');
  await initProject(dir);
  expect(count(dir)).toBe(first);
  expect(read(dir, 'AGENTS.md')).toBe(text);
});

it('leaves a CLAUDE.md that already imports AGENTS.md alone, and marks one that does not', async () => {
  const a = repo();
  writeFileSync(join(a, 'CLAUDE.md'), '# Claude\n@AGENTS.md\nmore\n');
  await initProject(a);
  expect(read(a, 'CLAUDE.md')).toBe('# Claude\n@AGENTS.md\nmore\n');
  const b = repo();
  writeFileSync(join(b, 'CLAUDE.md'), '# Claude\nmine\n');
  await initProject(b);
  expect(read(b, 'CLAUDE.md')).toBe(`# Claude\nmine\n\n${BEGIN}\n@AGENTS.md\n${END}\n`);
});

it('does not touch the files with --no-agents-md', async () => {
  const dir = repo();
  await initProject(dir, undefined, undefined, { agentsMd: false });
  const committed = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
  expect(committed).not.toContain('AGENTS.md');
  expect(committed).not.toContain('CLAUDE.md');
});

it("does not sweep the user's uncommitted AGENTS.md edits into the init commit", async () => {
  const dir = repo();
  writeFileSync(join(dir, 'AGENTS.md'), 'base\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
  writeFileSync(join(dir, 'AGENTS.md'), 'base\nwip\n');
  await initProject(dir);
  expect(read(dir, 'AGENTS.md')).toContain('wip');
  expect(execFileSync('git', ['-C', dir, 'show', 'HEAD:AGENTS.md'], { encoding: 'utf8' })).toBe('base\n');
});

it('refuses unbalanced markers instead of guessing', () => {
  expect(() => upsertBlock(`${BEGIN}\nx\n`, 'y')).toThrow(/apos:begin/);
});

it('names every command guarded by assertHuman in the block', async () => {
  const { readdirSync } = await import('node:fs');
  const dirs = [join('src', 'cli')];
  const names = new Set(['outcome close', 'outcome revise', 'outcome stop']); // `outcome ${decision}` is built at run time
  for (const base of dirs)
    for (const entry of readdirSync(base, { recursive: true, encoding: 'utf8' })) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('context.ts')) continue;
      const text = readFileSync(join(base, entry), 'utf8');
      for (const match of text.matchAll(/assertHuman\(\s*(['"])([^'"]+)\1/g)) names.add(match[2]!);
    }
  expect(names.size).toBeGreaterThan(8);
  const dir = repo();
  await initProject(dir);
  const block = read(dir, 'AGENTS.md');
  // `goal approve|appetite|select` stands for three commands
  const listed = new Set<string>();
  for (const [, prefix, alts] of block.matchAll(/`((?:[a-z]+ )*[a-z]+) ([a-z-]+(?:\|[a-z-]+)+)`/g))
    for (const alt of alts!.split('|')) listed.add(`${prefix} ${alt}`);
  for (const [whole, single] of block.matchAll(/`([a-z]+(?: [a-z]+)+)(?: --[a-z-]+)?`/g)) {
    listed.add(single!);
    listed.add(whole.slice(1, -1));
  }
  const missing = [...names].filter(name => !listed.has(name));
  expect(missing).toEqual([]);
});

it('does not recreate and commit over a tracked AGENTS.md the user deleted', async () => {
  const { rmSync: rm } = await import('node:fs');
  const dir = repo();
  writeFileSync(join(dir, 'AGENTS.md'), 'my rules\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
  rm(join(dir, 'AGENTS.md'));
  await initProject(dir);
  expect(execFileSync('git', ['-C', dir, 'show', 'HEAD:AGENTS.md'], { encoding: 'utf8' })).toBe('my rules\n');
});

it('commits the real file when AGENTS.md is a symlink to CLAUDE.md', async () => {
  const { symlinkSync } = await import('node:fs');
  const dir = repo();
  writeFileSync(join(dir, 'CLAUDE.md'), '# Mine\n');
  try {
    symlinkSync('CLAUDE.md', join(dir, 'AGENTS.md'));
  } catch {
    return; // no permission to create symlinks (Windows without developer mode)
  }
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
  await initProject(dir);
  expect(execFileSync('git', ['-C', dir, 'show', 'HEAD:CLAUDE.md'], { encoding: 'utf8' })).toContain('apos:begin');
  expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
});

it('writes but does not commit an AGENTS.md the project ignores', async () => {
  const dir = repo();
  writeFileSync(join(dir, '.gitignore'), 'AGENTS.md\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
  await initProject(dir);
  expect(read(dir, 'AGENTS.md')).toContain('apos:begin');
  const committed = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
  expect(committed).not.toContain('AGENTS.md');
  expect(committed).toContain('.apos/project.yaml');
});

it('does not abort when AGENTS.md is a symlink to a file outside the repository', async () => {
  const { symlinkSync } = await import('node:fs');
  const dir = repo();
  const outside = mkdtempSync(join(tmpdir(), 'apos-outside-'));
  dirs.push(outside);
  writeFileSync(join(outside, 'shared.md'), '# Shared\n');
  try {
    symlinkSync(join(outside, 'shared.md'), join(dir, 'AGENTS.md'));
  } catch {
    return; // no permission to create symlinks (Windows without developer mode)
  }
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
  await initProject(dir);
  expect(execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' })).toContain(
    '.apos/project.yaml',
  );
});
