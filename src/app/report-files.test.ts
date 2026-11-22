import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findReportFiles, readReportFiles } from './report-files.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tree = (files: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-report-files-'));
  dirs.push(dir);
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), file);
  }
  return dir;
};

it('matches a plain path, a star, and a globstar', () => {
  const dir = tree([
    'build/test-results/test/A.xml',
    'build/test-results/test/B.xml',
    'build/test-results/x/C.xml',
    'other.xml',
  ]);
  expect(findReportFiles(dir, 'other.xml')).toEqual(['other.xml']);
  expect(findReportFiles(dir, 'build/test-results/test/*.xml')).toEqual([
    'build/test-results/test/A.xml',
    'build/test-results/test/B.xml',
  ]);
  expect(findReportFiles(dir, 'build/**/*.xml')).toHaveLength(3);
  expect(findReportFiles(dir, 'build/test-results/test/*.json')).toEqual([]);
});
it('matches nothing for a missing file, an absolute path or a path leaving the tree', () => {
  const dir = tree(['a.xml']);
  expect(readReportFiles(dir, 'nope.xml')).toEqual([]);
  expect(findReportFiles(dir, '../a.xml')).toEqual([]);
  expect(findReportFiles(dir, '/etc/passwd')).toEqual([]);
});
