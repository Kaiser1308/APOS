import { execFileSync, spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { spec } from '../domain/fixtures.test-support.js';
import { cleanProjects, mapFor, setupDocument, testingProject } from './test-lock.test-support.js';

afterEach(cleanProjects);
const available = spawnSync('go', ['version']).status === 0 && spawnSync('gotestsum', ['--version']).status === 0;
if (!available) console.warn('Skipping Go test-lock e2e: go and gotestsum must both be on PATH.');

it.skipIf(!available).each(['init', 'TestMain', 'tagged'] as const)(
  'locks an active internal %s helper that changes an external acceptance test',
  async mechanism => {
    const previousProxy = process.env.GOPROXY;
    const previousToolchain = process.env.GOTOOLCHAIN;
    const previousFlags = process.env.GOFLAGS;
    process.env.GOPROXY = 'off';
    process.env.GOTOOLCHAIN = 'local';
    process.env.GOFLAGS = mechanism === 'tagged' ? '-tags=apos_selected' : '';
    try {
      const part = setupDocument.parts.app;
      const setup = {
        ...setupDocument,
        parts: {
          app: {
            ...part,
            stack: 'go',
            layers: {
              ...part.layers,
              L2: [
                { id: 'go', command: 'go run "{apos}/scripts/go-junit/main.go" --report "{report}"', format: 'junit' },
              ],
            },
            tests: {
              ...part.tests,
              paths: ['tests/**', '**/*_test.go'],
              assertPatterns: ['\\bt\\.Fatal'],
              entryRule: {
                goModule: true,
                importPatterns: ['^import'],
                allowImports: [],
                moduleSeparator: '/',
                moduleFiles: ['{path}.go'],
              },
            },
          },
        },
      };
      const p = await testingProject({
        setup,
        goal: { ...spec, kind: 'characterize', covers: ['app/app.go'] },
        paths: ['app/**', 'tests/unit/**'],
        files: {
          'go.mod': 'module example.com/demo\n\ngo 1.22\n',
          'app/app.go': 'package app\nvar Value = 0\n',
          'app/helper_test.go':
            mechanism === 'TestMain'
              ? 'package app\nimport ("os"; "testing")\nfunc TestMain(m *testing.M) { Value = 1; os.Exit(m.Run()) }\n'
              : `${mechanism === 'tagged' ? '//go:build apos_selected\n\n' : ''}package app\nfunc init() { Value = 1 }\n`,
          'app/ignored_test.go': '//go:build apos_never\n\npackage app\nfunc init() { Value = 999 }\n',
        },
      });
      const commit = p.commit(
        {
          'app/acceptance_test.go':
            'package app_test\nimport ("testing"; "example.com/demo/app")\nfunc TestValue(t *testing.T) { if app.Value != 1 { t.Fatalf("got %d", app.Value) } }\n',
          [`.apos/goals/${p.goalId}/tests.json`]: mapFor(p.goalId, ['app/acceptance_test.go::TestValue']),
        },
        'acceptance test',
      );
      execFileSync('go', ['test', '-count=1', './app'], { cwd: p.dir, stdio: 'pipe' });
      const helper = join(p.dir, 'app/helper_test.go');
      const hidden = join(p.dir, 'app/helper.hidden');
      renameSync(helper, hidden);
      try {
        const withoutHelper = spawnSync('go', ['test', '-count=1', './app'], { cwd: p.dir, encoding: 'utf8' });
        expect(withoutHelper.status).toBe(1);
        expect(withoutHelper.stdout).toContain('got 0');
      } finally {
        renameSync(hidden, helper);
      }
      const result = await p.service.submit(p.goalId, commit, 'tester');
      expect(result).toEqual({ ok: true, problems: [] });
      expect(p.state().testLock?.files['app/helper_test.go']).toBeDefined();
      if (mechanism === 'tagged') expect(p.state().testLock?.files['app/ignored_test.go']).toBeDefined();
      else expect(p.state().testLock?.files['app/ignored_test.go']).toBeUndefined();
    } finally {
      if (previousProxy === undefined) delete process.env.GOPROXY;
      else process.env.GOPROXY = previousProxy;
      if (previousToolchain === undefined) delete process.env.GOTOOLCHAIN;
      else process.env.GOTOOLCHAIN = previousToolchain;
      if (previousFlags === undefined) delete process.env.GOFLAGS;
      else process.env.GOFLAGS = previousFlags;
    }
  },
  180_000,
);
