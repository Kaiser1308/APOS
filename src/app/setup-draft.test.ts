import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { draftSetup } from './setup-draft.js';
import { STACKS } from '../domain/catalog-stacks.test-support.js';
import { UserError } from '../domain/errors.js';
import { loadCatalog } from './catalog-loader.js';
import { yamlCodec } from '../domain/setup-codec.js';

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
  it('detects Go and either ESP-IDF marker in separate parts', () => {
    const dir = repo({ 'server/go.mod': 'module example.com/server\n', 'firmware/sdkconfig': '' });
    const { entries, warnings } = loadCatalog({ codec: yamlCodec, home: repo({}) });
    expect(warnings).toEqual([]);
    const { setup } = draftSetup(dir, entries);
    expect(setup.parts.server?.stack).toBe('go');
    expect(setup.parts.firmware?.stack).toBe('cpp-espidf');
    expect(setup.parts.server?.manifests).toEqual(expect.arrayContaining(['go.mod', 'go.sum']));
    expect(setup.parts.server?.tests?.entryRule?.goModule).toBe(true);
    expect(setup.parts.firmware?.manifests).toEqual(expect.arrayContaining(['idf_component.yml', 'dependencies.lock']));
    const second = draftSetup(repo({ 'idf_component.yml': 'dependencies: {}\n' }), entries);
    expect(second.setup.parts.app?.stack).toBe('cpp-espidf');
  });
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
  it("copies the stack's test paths and patterns into the part, so the setup pins them", () => {
    for (const [files, stack] of [
      [ts, 'typescript'],
      [{ 'pyproject.toml': '[project]\nname="x"\n' }, 'python'],
    ] as const) {
      const entry = STACKS.find(item => item.stack === stack)!;
      const tests = draftSetup(repo(files), STACKS).setup.parts.app?.tests;
      expect(tests, stack).toEqual({
        paths: entry.testPaths,
        infra: entry.testInfra,
        assertPatterns: entry.assertPatterns,
        notImplementedPatterns: entry.notImplementedPatterns,
        loadErrorPatterns: entry.loadErrorPatterns,
        noTestsExitCodes: entry.noTestsExitCodes,
        noTestsPatterns: entry.noTestsPatterns,
        entryRule: entry.entryRule,
      });
      expect(tests?.paths.length).toBeGreaterThan(0);
    }
  });
  it('gives each stack its test paths', () => {
    const byStack = Object.fromEntries(STACKS.map(entry => [entry.stack, entry.testPaths]));
    expect(byStack['python']).toEqual(expect.arrayContaining(['tests/**', '**/test_*.py']));
    expect(byStack['typescript']).toEqual(expect.arrayContaining(['**/*.test.ts', '**/*.spec.ts', 'tests/**']));
    expect(byStack['java-gradle']).toEqual(['src/test/**']);
    expect(byStack['java-maven']).toEqual(['src/test/**']);
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
