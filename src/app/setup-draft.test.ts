import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { draftSetup } from './setup-draft.js';
import { STACKS } from '../domain/catalog-stacks.test-support.js';
import { UserError } from '../domain/errors.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-draft-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
};
const ts = { 'package.json': '{"devDependencies":{"vitest":"^4"}}', 'tsconfig.json': '{}' };

describe('draftSetup', () => {
  it('drafts a TypeScript repo as one part with the first tool per layer and the strict floor', () => {
    const { setup, notes } = draftSetup(repo(ts), STACKS);
    expect(notes).toEqual([]);
    const app = setup.parts.app!;
    expect(app).toMatchObject({ root: '.', stack: 'typescript' });
    expect(app.layers.L0?.map(tool => tool.id)).toEqual(['tsc']);
    expect(app.layers.L1?.map(tool => tool.id)).toEqual(['vitest']);
    expect(app.layers.L2?.[0]?.runOne).toBeDefined();
    expect(app.forbid.length).toBeGreaterThan(0);
    expect(app.needsHuman).toContain('package.json');
    expect(setup.floor).toEqual({
      submit: ['L0', 'L1', 'L2'],
      integrate: ['L1', 'L2', 'L3'],
      close: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
    });
    expect(setup.mutation).toEqual({ minScore: 70 });
  });
  it('drafts a Python repo', () => {
    const { setup } = draftSetup(repo({ 'pyproject.toml': '[project]\nname="x"\n' }), STACKS);
    expect(setup.parts.app).toMatchObject({ stack: 'python' });
    expect(setup.parts.app?.layers.L1?.[0]?.command).toContain('--junitxml={report}');
  });
  it('drafts a two-part repo from the directories one level down', () => {
    const { setup, notes } = draftSetup(
      repo({
        'backend/gradlew': '#!/bin/sh',
        'backend/build.gradle': '',
        'frontend/package.json': '{"devDependencies":{"vitest":"^4"}}',
        'docs/readme.md': '',
        '.hidden/package.json': '{}',
        'node_modules/x/package.json': '{}',
      }),
      STACKS,
    );
    expect(notes).toEqual([]);
    expect(Object.keys(setup.parts).sort()).toEqual(['backend', 'frontend']);
    expect(setup.parts.backend).toMatchObject({ root: 'backend', stack: 'java-gradle' });
    expect(setup.parts.frontend).toMatchObject({ root: 'frontend', stack: 'typescript' });
  });
  it('keeps a part whose stack it cannot name empty, with a note, and still drafts the rest', () => {
    const { setup, notes } = draftSetup(
      repo({
        'backend/pom.xml': '<project/>',
        'frontend/package.json': '{"devDependencies":{"jest":"^29"}}',
      }),
      STACKS,
    );
    expect(setup.parts.backend?.stack).toBe('java-maven');
    expect(setup.parts.frontend).toMatchObject({ root: 'frontend', layers: {}, note: 'chưa nhận ra stack' });
    expect(setup.parts.frontend?.stack).toBeUndefined();
    expect(notes.join('\n')).toMatch(/frontend \(frontend\): chưa nhận ra stack/);
  });
  it('makes no part, and says so, for a directory it does not know', () => {
    const { setup, notes } = draftSetup(repo({ 'notes.txt': 'hi', 'data/a.csv': '1' }), STACKS);
    expect(setup.parts).toEqual({});
    expect(notes[0]).toMatch(/chưa nhận ra stack nào/);
  });
  it('takes --part as given: an explicit stack, a detected one, and an empty one for an unknown directory', () => {
    const dir = repo({
      ...Object.fromEntries(Object.entries(ts).map(([k, v]) => [`web/${k}`, v])),
      'mystery/x.txt': '',
      'py/x.txt': '',
    });
    const { setup, notes } = draftSetup(dir, STACKS, {
      parts: { web: { root: 'web' }, legacy: { root: 'mystery' }, api: { root: 'py', stack: 'python' } },
    });
    expect(setup.parts.web?.stack).toBe('typescript');
    expect(setup.parts.legacy).toMatchObject({ layers: {}, note: 'chưa nhận ra stack' });
    expect(setup.parts.api?.stack).toBe('python');
    expect(notes).toHaveLength(1);
  });
  it('refuses --part with a missing directory or an unknown stack, and says so when two stacks match', () => {
    const dir = repo({ ...ts, 'pom.xml': '<project/>' });
    expect(() => draftSetup(dir, STACKS, { parts: { x: { root: 'nope' } } })).toThrow(UserError);
    expect(() => draftSetup(dir, STACKS, { parts: { x: { root: '.', stack: 'cobol' } } })).toThrow(/no stack "cobol"/);
    const { setup, notes } = draftSetup(dir, STACKS);
    expect(setup.parts.app?.layers).toEqual({});
    expect(notes[0]).toMatch(/khớp nhiều stack \(typescript, java-maven\)/);
  });
  it('says so when the root and a subdirectory both match, and builds parts only from the subdirectory', () => {
    const dir = repo({ ...ts, 'services/api/pom.xml': '<project/>', 'api/pom.xml': '<project/>' });
    const { setup, notes } = draftSetup(dir, STACKS);
    expect(Object.keys(setup.parts)).toEqual(['api']);
    expect(notes[0]).toMatch(/thư mục gốc cũng khớp typescript/);
  });
});
