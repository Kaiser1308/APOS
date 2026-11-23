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
