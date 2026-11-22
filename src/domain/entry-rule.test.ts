import { describe, expect, it } from 'vitest';
import { entryRuleSchema, entryViolations, type EntryRule } from './entry-rule.js';

const python: EntryRule = entryRuleSchema.parse({
  importPatterns: ['^\\s*from\\s+([\\w.]+)\\s+import\\s+([^#]+)', '^\\s*import\\s+([\\w.]+(?:\\s*,\\s*[\\w.]+)*)'],
  allowImports: ['^(?:pytest|unittest)(?:\\.|$)'],
  moduleSeparator: '.',
  moduleFiles: ['{path}.py', '{path}/__init__.py'],
});
const ts: EntryRule = entryRuleSchema.parse({
  importPatterns: [
    '^\\s*(?:import|export)\\b[^\'"\\n]*?\\bfrom\\s+[\'"]([^\'"]+)[\'"]',
    '^\\s*\\}\\s*from\\s+[\'"]([^\'"]+)[\'"]',
    '^\\s*import\\s+[\'"]([^\'"]+)[\'"]',
  ],
  allowImports: ['^vitest$', '^node:'],
  moduleSeparator: '/',
  moduleFiles: ['{path}.ts', '{path}/index.ts'],
  stripExtension: '\\.(?:js|ts)$',
});
const repo =
  (...files: string[]) =>
  (path: string) =>
    files.includes(path);
const check = (rule: EntryRule, file: string, text: string, files: string[], allowed: string[], partRoot = '.') =>
  entryViolations({ rule, file, text, partRoot, exists: repo(...files), allowed: path => allowed.includes(path) });

describe('entryViolations', () => {
  it('python: calling the declared entry is fine, and so are libraries', () => {
    const text = 'import pytest\nfrom calc import add\nimport os\n';
    expect(check(python, 'tests/acceptance/test_calc.py', text, ['calc.py'], ['calc.py'])).toEqual([]);
  });
  it('python: an internal module that is not an entry is refused with file and line', () => {
    const text = 'from calc import add\nfrom pkg.internal import secret\n';
    expect(check(python, 'tests/acceptance/test_calc.py', text, ['calc.py', 'pkg/internal.py'], ['calc.py'])).toEqual([
      'tests/acceptance/test_calc.py:2: imports "pkg.internal" (pkg/internal.py), an internal module that is not a declared entry: a test may call only the entries in stubPaths',
    ]);
  });
  it('python: a package __init__ counts, and a helper under the tests is allowed', () => {
    const files = ['pkg/__init__.py', 'tests/helpers.py'];
    expect(
      check(python, 'tests/acceptance/test_a.py', 'import pkg\nfrom tests.helpers import h\n', files, [
        'tests/helpers.py',
      ]),
    ).toEqual([expect.stringContaining('test_a.py:1: imports "pkg" (pkg/__init__.py)') as unknown]);
  });
  it('python: a relative import is read from the test file', () => {
    expect(
      check(
        python,
        'tests/acceptance/test_a.py',
        'from .conftest_helpers import x\n',
        ['tests/acceptance/conftest_helpers.py'],
        ['tests/acceptance/conftest_helpers.py'],
      ),
    ).toEqual([]);
    expect(
      check(python, 'tests/acceptance/test_a.py', 'from ..shared import x\n', ['tests/shared.py'], []),
    ).toHaveLength(1);
  });
  it('python: a part root prefixes the module path', () => {
    expect(check(python, 'svc/tests/test_a.py', 'import app.core\n', ['svc/app/core.py'], [], 'svc')).toHaveLength(1);
    expect(
      check(python, 'svc/tests/test_a.py', 'import app.core\n', ['svc/app/core.py'], ['svc/app/core.py'], 'svc'),
    ).toEqual([]);
  });
  it('typescript: a relative import with its .js ending finds the .ts file', () => {
    const text =
      "import { it } from 'vitest';\nimport { add } from './calc.js';\nimport { inner } from './inner/deep.js';\n";
    const files = ['src/calc.ts', 'src/inner/deep.ts'];
    expect(check(ts, 'src/calc.acceptance.test.ts', text, files, ['src/calc.ts'])).toEqual([
      expect.stringContaining('calc.acceptance.test.ts:3: imports "./inner/deep.js" (src/inner/deep.ts)') as unknown,
    ]);
  });
  it('typescript: a library that is not in the repo is never judged, and node: is allowed', () => {
    expect(check(ts, 'src/a.test.ts', "import x from 'lodash';\nimport fs from 'node:fs';\n", [], [])).toEqual([]);
  });
  it('a line that does not import is skipped, and CRLF text is read as lines', () => {
    expect(check(python, 'tests/t.py', 'x = 1\r\nfrom lib import y\r\n', ['lib.py'], [])).toEqual([
      expect.stringContaining('t.py:2:') as unknown,
    ]);
  });
  it('refuses a rule whose pattern does not compile', () => {
    expect(() => entryRuleSchema.parse({ ...python, importPatterns: ['('] })).toThrow();
  });
  it('python: `from pkg import internal` takes a submodule of pkg, with or without a package __init__', () => {
    const files = ['pkg/internal.py', 'pkg/okay.py'];
    expect(check(python, 'tests/t.py', 'from pkg import internal\n', files, [])).toEqual([
      expect.stringContaining('t.py:1: imports "pkg.internal" (pkg/internal.py)') as unknown,
    ]);
    expect(
      check(python, 'tests/t.py', 'from pkg import okay as fine, internal\n', files, ['pkg/okay.py']),
    ).toHaveLength(1);
    expect(check(python, 'tests/t.py', 'from pkg import (okay)\n', files, ['pkg/okay.py'])).toEqual([]);
    expect(check(python, 'tests/t.py', 'from pkg import *\n', files, [])).toEqual([]);
    expect(
      check(python, 'tests/acceptance/t.py', 'from . import helper\n', ['tests/acceptance/helper.py'], []),
    ).toHaveLength(1);
  });
  it('python: a trailing comment is not part of the imported names', () => {
    const files = ['pkg/internal.py'];
    expect(check(python, 'tests/t.py', 'from pkg import internal  # needed for setup\n', files, [])).toEqual([
      expect.stringContaining('imports "pkg.internal"') as unknown,
    ]);
    expect(check(python, 'tests/t.py', '# from pkg import internal\n', files, [])).toEqual([]);
  });
  it('python: `import a, b` judges every module', () => {
    expect(
      check(python, 'tests/t.py', 'import os, lib_a, lib_b as b\n', ['lib_a.py', 'lib_b.py'], ['lib_a.py']),
    ).toEqual([expect.stringContaining('imports "lib_b"') as unknown]);
  });
  it('typescript: a comment or a sentence that says "from" imports nothing', () => {
    const files = ['src/internal.ts'];
    const text = [
      '// derived from "./internal.js"',
      ' * from "./internal.js"',
      'const note = \'taken from "./internal.js"\';',
      "it('x', () => {});",
    ].join('\n');
    expect(check(ts, 'src/a.test.ts', text, files, [])).toEqual([]);
  });
  it('typescript: export-from, a multi-line import and a side-effect import are imports', () => {
    const files = ['src/internal.ts'];
    for (const text of [
      "export { x } from './internal.js';",
      "import {\n  a,\n  b,\n} from './internal.js';",
      "import './internal.js';",
    ])
      expect(check(ts, 'src/a.test.ts', text, files, []), text).toHaveLength(1);
  });
});
