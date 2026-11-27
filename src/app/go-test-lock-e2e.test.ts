import { execFileSync, spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { spec } from '../domain/fixtures.test-support.js';
import { AssuranceService } from './assurance-service.js';
import { GitCommitInspector } from './integration.js';
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
      expect(p.state().testLock?.files['app/ignored_test.go']).toBeDefined();
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

it.skipIf(!available).each(['existing', 'added'] as const)(
  'rejects an %s helper when a later gate enables its build tag',
  async mode => {
    const saved = { GOPROXY: process.env.GOPROXY, GOTOOLCHAIN: process.env.GOTOOLCHAIN, GOFLAGS: process.env.GOFLAGS };
    process.env.GOPROXY = 'off';
    process.env.GOTOOLCHAIN = 'local';
    process.env.GOFLAGS = '';
    try {
      const targetOS = execFileSync('go', ['env', 'GOOS'], { encoding: 'utf8' }).trim();
      const otherOS = targetOS === 'windows' ? 'linux' : 'windows';
      const platformHelper = `app/platform_${otherOS}_test.go`;
      const part = setupDocument.parts.app;
      const setup = {
        ...setupDocument,
        parts: {
          app: {
            ...part,
            stack: 'go',
            layers: {
              L2: [
                { id: 'go', command: 'go run "{apos}/scripts/go-junit/main.go" --report "{report}"', format: 'junit' },
              ],
            },
            tests: {
              ...part.tests,
              paths: ['**/*_test.go'],
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
        goal: spec,
        paths: ['app/**'],
        plan: { stubPaths: ['app/app.go'] },
        files: {
          'go.mod': 'module example.com/demo\n\ngo 1.22\n',
          'app/app.go': 'package app\nvar Value = 0\n',
          ...(mode === 'existing'
            ? { 'app/helper_test.go': '//go:build apos_selected\n\npackage app\nfunc init() {}\n' }
            : {}),
          [platformHelper]: 'package app\nfunc init() {}\n',
        },
      });
      const locked = p.commit(
        {
          'app/acceptance_test.go':
            'package app_test\nimport ("testing"; "example.com/demo/app")\nfunc TestValue(t *testing.T) { if app.Value != 1 { t.Fatalf("got %d", app.Value) } }\n',
          [`.apos/goals/${p.goalId}/tests.json`]: mapFor(p.goalId, ['app/acceptance_test.go::TestValue']),
        },
        'acceptance',
      );
      expect(await p.service.submit(p.goalId, locked, 'tester')).toEqual({ ok: true, problems: [] });
      expect(p.state().testLock?.files[platformHelper]).toBeDefined();
      const head = p.commit(
        {
          'app/helper_test.go': '//go:build apos_selected\n\npackage app\nfunc init() { Value = 1 }\n',
        },
        'weaken with tagged helper',
      );
      process.env.GOFLAGS = '-tags=apos_selected';
      execFileSync('go', ['test', '-count=1', './app'], { cwd: p.dir, stdio: 'pipe' });
      const assurance = new AssuranceService({
        repo: p.dir,
        runner: p.runner,
        inspector: new GitCommitInspector(),
        loadSetup: p.loadSetup,
      });
      const checks = assurance.layerChecks(p.state(), {
        stage: 'integrate',
        scope: p.goalId,
        head,
        base: locked,
        changed: ['app/helper_test.go'],
      }).checks;
      expect(checks.find(check => check.checkId === 'APOS-LOCKED')).toMatchObject({
        status: mode === 'existing' ? 'fail' : 'unverifiable',
        reason: expect.stringContaining('app/helper_test.go'),
      });
    } finally {
      for (const key of ['GOPROXY', 'GOTOOLCHAIN', 'GOFLAGS'] as const) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  },
  240_000,
);
