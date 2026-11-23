import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from './catalog-loader.js';
import { STACKS } from '../domain/catalog-stacks.test-support.js';
import { jsonCodec } from '../domain/setup-codec.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const home = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-catalog-home-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'catalog'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, 'catalog', name), content);
  return dir;
};

it('every file shipped in catalog/ passes the schema, and matches the content the tests were written against', () => {
  const { entries, warnings } = loadCatalog({ codec: jsonCodec, home: home({}) });
  expect(warnings).toEqual([]);
  expect(entries.map(entry => entry.stack).sort()).toEqual(['java-gradle', 'java-maven', 'python', 'typescript']);
  for (const stack of STACKS) expect(entries.find(entry => entry.stack === stack.stack)).toEqual(stack);
});
it('a file in home replaces the bundled entry of the same stack and can add a new one', () => {
  const python = { ...STACKS.find(entry => entry.stack === 'python')!, forbid: ['custom-forbid'] };
  const go = { ...python, stack: 'go', forbid: [] };
  const { entries, warnings } = loadCatalog({
    codec: jsonCodec,
    home: home({ 'python.json': jsonCodec.stringify(python), 'go.json': jsonCodec.stringify(go) }),
  });
  expect(warnings).toEqual([]);
  expect(entries.find(entry => entry.stack === 'python')?.forbid).toEqual(['custom-forbid']);
  expect(entries.map(entry => entry.stack)).toContain('go');
  expect(entries).toHaveLength(5);
});
it('skips a broken or invalid file with a warning and keeps the rest', () => {
  const { entries, warnings } = loadCatalog({
    codec: jsonCodec,
    home: home({ 'bad.json': '{ nope', 'worse.json': '{"stack":"x"}', 'ignored.txt': 'x' }),
  });
  expect(entries).toHaveLength(4);
  expect(warnings).toHaveLength(2);
  expect(warnings.join('\n')).toMatch(/bad\.json: skipped, cannot be read/);
  expect(warnings.join('\n')).toMatch(/worse\.json: skipped/);
});
it('works with no home catalog directory at all', () => {
  const empty = mkdtempSync(join(tmpdir(), 'apos-catalog-empty-'));
  dirs.push(empty);
  expect(loadCatalog({ codec: jsonCodec, home: empty }).entries).toHaveLength(4);
});
