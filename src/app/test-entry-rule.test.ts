import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cleanProjects, goodTests, setupDocument, testingProject } from './test-lock.test-support.js';

afterEach(cleanProjects);

/** The fake stack reads `use <module>` lines; a module `a.b` is the file `a/b.txt`. */
const withRule = (extra: object = {}) => {
  const part = setupDocument.parts.app;
  return {
    ...setupDocument,
    parts: {
      app: {
        ...part,
        tests: {
          ...part.tests,
          entryRule: {
            importPatterns: ['^use (\\S+)$'],
            allowImports: ['^lib\\.'],
            moduleSeparator: '.',
            moduleFiles: ['{path}.txt'],
            ...extra,
          },
        },
      },
    },
  };
};

const tests = (goalId: string, lines: string) => ({
  ...goodTests(goalId),
  'tests/acceptance/calc.t': `${lines}case add needs add\n`,
});

describe('tests go through the declared entries (plan task 5)', () => {
  it.skipIf(spawnSync('go', ['version']).status !== 0)(
    'enforces Go module imports during test submission',
    async () => {
      const p = await testingProject({
        setup: withRule({ goModule: true }),
        files: { 'go.mod': 'module example.com/demo\n', 'internal/secret.go': 'package secret\n' },
      });
      const commit = p.commit(
        {
          ...goodTests(p.goalId),
          'tests/acceptance/calc.t':
            'package acceptance_test\nimport "example.com/demo/internal"\nvar _ = `\ncase add needs add\n`\n',
        },
        'tests',
      );
      const result = await p.service.submit(p.goalId, commit, 'tester');
      expect(result.ok).toBe(false);
      expect(result.problems.join('\n')).toContain('internal/secret.go');
    },
    60_000,
  );
  it('locks a suite that only imports the declared stub, a library, and its own helpers', async () => {
    const p = await testingProject({
      setup: withRule(),
      files: { 'lib/x.txt': 'shadow\n', 'tests/helper.txt': 'h\n' },
    });
    const commit = p.commit(tests(p.goalId, 'use src.stub\nuse lib.x\nuse tests.helper\nuse requests\n'), 'tests');
    expect(await p.service.submit(p.goalId, commit, 'tester')).toEqual({ ok: true, problems: [] });
  }, 60_000);

  it('refuses an internal module that is not an entry, naming the file and the line', async () => {
    const p = await testingProject({ setup: withRule() });
    const commit = p.commit(tests(p.goalId, 'use src.stub\nuse src.impl\n'), 'tests');
    const result = await p.service.submit(p.goalId, commit, 'tester');
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain(
      'tests/acceptance/calc.t:2: imports "src.impl" (src/impl.txt), an internal module that is not a declared entry',
    );
    expect(p.state().status).toBe('testing');
  }, 60_000);

  it('a stack with no rule is not checked: the same suite locks', async () => {
    const p = await testingProject();
    const commit = p.commit(tests(p.goalId, 'use src.impl\n'), 'tests');
    expect(await p.service.submit(p.goalId, commit, 'tester')).toEqual({ ok: true, problems: [] });
  }, 60_000);

  it('applies to a revision too', async () => {
    const p = await testingProject({ setup: withRule() });
    const first = p.commit(tests(p.goalId, 'use src.stub\n'), 'tests');
    expect((await p.service.submit(p.goalId, first, 'tester')).ok).toBe(true);
    const next = p.commit(tests(p.goalId, 'use src.stub\nuse src.impl\n'), 'revised tests');
    const revised = await p.service.revise(p.goalId, next, 'more', 'tester');
    expect(revised.ok).toBe(false);
    expect(revised.problems.join('\n')).toContain('imports "src.impl"');
  }, 60_000);
});
