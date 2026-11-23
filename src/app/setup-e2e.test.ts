import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadCatalog } from './catalog-loader.js';
import { draftSetup } from './setup-draft.js';
import { probeSetup } from './setup-probe.js';
import { yamlCodec } from '../domain/setup-codec.js';
import type { ProjectSetup } from '../domain/project-setup.js';

/**
 * A draft taken from the shipped catalog must pass the probe on a typical repo of the stack, with the real
 * tool. Skipped when the tool is not on this machine. Layers whose tools need more installed (linters, scanners)
 * are dropped from the draft: this checks the test runners and their `runOne`.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const hasPytest = spawnSync('pytest', ['--version']).status === 0;
const vitestBin = resolve('node_modules', '.bin', 'vitest');
const hasVitest = existsSync(vitestBin);

function commitAll(dir: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'files');
  return git('rev-parse', 'HEAD');
}

async function probeDraft(dir: string, stack: string) {
  const { entries } = loadCatalog({ codec: yamlCodec, home: temp('apos-e2e-home-') });
  const { setup, notes } = draftSetup(dir, entries);
  expect(notes).toEqual([]);
  expect(setup.parts.app?.stack).toBe(stack);
  const runners: ProjectSetup = {
    ...setup,
    parts: {
      app: { ...setup.parts.app!, layers: { ...setup.parts.app!.layers, L0: undefined, L5: undefined } },
    },
  };
  const commit = commitAll(dir, { '.apos/project.yaml': yamlCodec.stringify(runners) });
  const report = await probeSetup(dir, commit, {
    codec: yamlCodec,
    artifactRoot: temp('apos-e2e-art-'),
    catalog: entries,
  });
  return report;
}

describe.skipIf(!hasPytest)('python draft on a typical pytest repo', () => {
  const calc = `import pytest

def test_add():
    assert 1 + 1 == 2

def test_add_neg():
    assert -1 + -1 == -2

@pytest.mark.parametrize("n", [1, 2])
def test_double(n):
    assert n * 2 == n + n

class TestCalc:
    def test_mul(self):
        assert 2 * 3 == 6
`;
  it('passes the probe: runOne picks test_add alone although test_add_neg shares its prefix, and a class test too', async () => {
    const dir = temp('apos-e2e-py-');
    execFileSync('git', ['init', '-q', dir]);
    commitAll(dir, {
      'pyproject.toml': '[project]\nname = "x"\nversion = "0"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      'tests/test_unit.py': 'def test_unit():\n    assert True\n',
      'tests/acceptance/test_calc.py': calc,
      'tests/integration/test_flow.py': 'def test_flow():\n    assert True\n',
    });
    const report = await probeDraft(dir, 'python');
    expect(report.results.filter(item => !item.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.results.find(item => item.layer === 'L2')?.reason).toMatch(/runOne ok/);
  }, 180_000);
  it('runs a class test alone when it comes first', async () => {
    const dir = temp('apos-e2e-py-class-');
    execFileSync('git', ['init', '-q', dir]);
    commitAll(dir, {
      'pyproject.toml': '[project]\nname = "x"\nversion = "0"\n',
      'tests/test_unit.py': 'def test_unit():\n    assert True\n',
      'tests/acceptance/test_calc.py':
        'class TestCalc:\n    def test_mul(self):\n        assert 2 * 3 == 6\n\n    def test_mul_neg(self):\n        assert 1\n',
      'tests/integration/test_flow.py': 'def test_flow():\n    assert True\n',
    });
    const report = await probeDraft(dir, 'python');
    expect(report.results.filter(item => !item.ok)).toEqual([]);
  }, 180_000);
  it('fails the probe when a test module cannot be imported, saying the tests could not load', async () => {
    const dir = temp('apos-e2e-py-broken-');
    execFileSync('git', ['init', '-q', dir]);
    commitAll(dir, {
      'pyproject.toml': '[project]\nname = "x"\nversion = "0"\n',
      'tests/test_unit.py': 'def test_unit():\n    assert True\n',
      'tests/acceptance/test_calc.py': 'import no_such_module_xyz\n\ndef test_a():\n    assert True\n',
      'tests/integration/test_flow.py': 'def test_flow():\n    assert True\n',
    });
    const report = await probeDraft(dir, 'python');
    expect(report.ok).toBe(false);
    expect(report.results.find(item => item.layer === 'L2')?.reason).toMatch(/^tests could not load/);
  }, 180_000);
});

describe.skipIf(!hasVitest)('typescript draft on a typical vitest repo', () => {
  function tsRepo(acceptance: string): string {
    const dir = temp('apos-e2e-ts-');
    execFileSync('git', ['init', '-q', dir]);
    // The lock file is identical in the main checkout and in the probe worktree, so the gate links node_modules.
    commitAll(dir, {
      '.gitignore': 'node_modules\n',
      'package.json': '{"name":"x","version":"0.0.0","type":"module","devDependencies":{"vitest":"*"}}',
      'package-lock.json': `${JSON.stringify({ name: 'x', lockfileVersion: 3, requires: true, packages: {} })}\n`,
      'src/unit.test.ts': "import { it, expect } from 'vitest';\nit('unit', () => expect(1).toBe(1));\n",
      'src/calc.acceptance.test.ts': acceptance,
      'src/flow.integration.test.ts': "import { it, expect } from 'vitest';\nit('flow', () => expect(1).toBe(1));\n",
    });
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return dir;
  }
  it('passes the probe with describe nested two deep and names holding regex characters', async () => {
    const dir = tsRepo(`import { describe, it, expect } from 'vitest';
describe('calc', () => {
  describe('add (positive)', () => {
    it('adds 1 + 1.', () => expect(1 + 1).toBe(2));
    it('adds 1 + 1. more', () => expect(1 + 1).toBe(2));
  });
  it('multiplies', () => expect(2 * 3).toBe(6));
});
it('top level', () => expect(1).toBe(1));
`);
    const report = await probeDraft(dir, 'typescript');
    expect(report.results.filter(item => !item.ok)).toEqual([]);
    expect(report.results.find(item => item.layer === 'L2')?.reason).toMatch(/runOne ok/);
  }, 240_000);
});
