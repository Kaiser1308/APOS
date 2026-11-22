import { describe, expect, it } from 'vitest';
import { catalogEntrySchema, catalogToolSchema } from './catalog.js';
import { STACKS } from './catalog-stacks.test-support.js';
import { parseSetupObject } from './project-setup.js';

describe('first-wave catalog content', () => {
  it('has the four stacks, each valid against the schema', () => {
    expect(STACKS.map(entry => entry.stack)).toEqual(['typescript', 'python', 'java-gradle', 'java-maven']);
    for (const entry of STACKS) expect(catalogEntrySchema.safeParse(entry).success, entry.stack).toBe(true);
  });
  it('gives every stack L1 and L2 that write a standard report, and a runOne on L2', () => {
    for (const entry of STACKS) {
      for (const layer of ['L1', 'L2'] as const) {
        const tools = entry.layers[layer] ?? [];
        expect(tools.length, `${entry.stack} ${layer}`).toBeGreaterThan(0);
        for (const tool of tools) {
          expect(tool.format, tool.id).toBe('junit');
          expect(tool.command.includes('{report}') || tool.report !== undefined, tool.id).toBe(true);
        }
      }
      expect(entry.layers.L2?.[0]?.runOne, entry.stack).toBeDefined();
    }
  });
  it('tells Python and TypeScript how to read an import; Java has no rule yet, and the table says "chưa kiểm"', () => {
    const rules = Object.fromEntries(STACKS.map(entry => [entry.stack, entry.entryRule !== undefined]));
    expect(rules).toEqual({ typescript: true, python: true, 'java-gradle': false, 'java-maven': false });
    const read = (stack: string, line: string) => {
      const rule = STACKS.find(entry => entry.stack === stack)!.entryRule!;
      return rule.importPatterns.map(pattern => new RegExp(pattern).exec(line)?.[1]).find(Boolean);
    };
    expect(read('python', 'from app.core import run')).toBe('app.core');
    expect(read('python', 'import app')).toBe('app');
    expect(read('python', '# from app.core import run')).toBeUndefined();
    expect(read('typescript', "import { add } from './calc.js';")).toBe('./calc.js');
    expect(read('typescript', '} from "./calc.js";')).toBe('./calc.js');
    expect(read('typescript', "// derived from './calc.js'")).toBeUndefined();
  });
  it('gives every stack a strict floor and wave-3 patterns that match what they should', () => {
    for (const entry of STACKS) {
      expect(entry.forbid.length, entry.stack).toBeGreaterThan(0);
      expect(entry.needsHuman.length, entry.stack).toBeGreaterThan(0);
    }
    const match = (stack: string, key: 'assertPatterns' | 'notImplementedPatterns' | 'forbid', text: string) =>
      STACKS.find(entry => entry.stack === stack)![key].some(pattern => new RegExp(pattern, 'm').test(text));
    expect(match('typescript', 'assertPatterns', 'expect(a).toBe(1)')).toBe(true);
    expect(match('typescript', 'forbid', "it.only('x', () => {})")).toBe(true);
    expect(match('typescript', 'forbid', "it('x', () => {})")).toBe(false);
    expect(match('python', 'assertPatterns', '    assert x == 1')).toBe(true);
    expect(match('python', 'notImplementedPatterns', 'E   NotImplementedError')).toBe(true);
    expect(match('python', 'forbid', '@pytest.mark.skip(reason="x")')).toBe(true);
    expect(match('java-gradle', 'assertPatterns', 'assertEquals(1, x);')).toBe(true);
    expect(match('java-maven', 'notImplementedPatterns', 'java.lang.UnsupportedOperationException: nope')).toBe(true);
    expect(match('java-maven', 'forbid', '@Disabled("flaky")')).toBe(true);
  });
  it('turns into a valid setup layer: a catalog tool is a layer spec', () => {
    const entry = STACKS[0]!;
    const parsed = parseSetupObject({
      schemaVersion: 2,
      parts: {
        app: {
          root: '.',
          layers: { L1: entry.layers.L1, L2: entry.layers.L2 },
          needsHuman: entry.needsHuman,
          forbid: entry.forbid,
        },
      },
    });
    expect(parsed.version).toBe(2);
  });
});

describe('catalog schema', () => {
  const entry = STACKS[0]!;
  it('refuses a regex that does not compile', () => {
    expect(catalogEntrySchema.safeParse({ ...entry, forbid: ['('] }).success).toBe(false);
  });
  it('refuses layer L6 (hand confirmation is not a tool) and an empty tool list', () => {
    expect(catalogEntrySchema.safeParse({ ...entry, layers: { L6: entry.layers.L1 } }).success).toBe(false);
    expect(catalogEntrySchema.safeParse({ ...entry, layers: { L1: [] } }).success).toBe(false);
  });
  it('refuses a stack name that is not a lowercase word and a detect with no files', () => {
    expect(catalogEntrySchema.safeParse({ ...entry, stack: 'Java Gradle' }).success).toBe(false);
    expect(catalogEntrySchema.safeParse({ ...entry, detect: { files: [] } }).success).toBe(false);
  });
  it('refuses runOne without a placeholder and an unknown format', () => {
    const tool = { id: 't', command: 'x', format: 'junit' as const };
    expect(catalogToolSchema.safeParse({ ...tool, runOne: 'vitest' }).success).toBe(false);
    expect(catalogToolSchema.safeParse({ ...tool, runOne: 'vitest -t {name}' }).success).toBe(true);
    expect(catalogToolSchema.safeParse({ ...tool, format: 'tap' }).success).toBe(false);
  });
});

describe('test infrastructure globs', () => {
  it('every stack lists some, and the draft copies them into the part', async () => {
    for (const entry of STACKS) expect(entry.testInfra.length, entry.stack).toBeGreaterThan(0);
    const byStack = Object.fromEntries(STACKS.map(entry => [entry.stack, entry.testInfra]));
    expect(byStack['python']).toEqual(
      expect.arrayContaining(['**/conftest.py', 'pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml']),
    );
    expect(byStack['typescript']).toEqual(
      expect.arrayContaining(['vitest.config.*', 'jest.config.*', '**/vitest.setup.*', 'tsconfig*.json']),
    );
    expect(byStack['java-maven']).toEqual(expect.arrayContaining(['src/test/resources/**', 'pom.xml']));
  });
});
