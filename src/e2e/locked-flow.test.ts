import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runCli } from '../cli.js';
import { ProjectJournal } from '../store/journal.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { sourceText, spec } from '../domain/fixtures.test-support.js';

/**
 * The whole test-lock flow through the CLI with a real test runner: setup (draft, probe, approve) → Goal → plan → a
 * tester's tests (refused while green, locked once red on a stub) → worker packages (red for a changed locked test,
 * red for a lost test, needs-human for a sensitive file, then an agent's exception, then green) → close.
 * Skipped when the runner is not on this machine.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
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

type Stack = {
  name: string;
  files: Record<string, string>;
  /** Files the tester commits when the stub already works, and when it says "not implemented". */
  green: Record<string, string>;
  red: Record<string, string>;
  /** The id the tester's test has in the layer's report. */
  testId: string;
  lockedTest: string;
  l1Test: string;
  implement: Record<string, string>;
  sensitive: [string, string];
  check: string;
  paths: string[];
  stubPaths: string[];
  /** Test infrastructure that makes the locked red test read green, and the files it adds. */
  swallow: Record<string, string>;
  infraFiles: string[];
  setup?: (dir: string) => void;
};

const python: Stack = {
  name: 'python (pytest)',
  files: {
    '.gitignore': '__pycache__/\n.pytest_cache/\n',
    'pyproject.toml': '[project]\nname = "x"\nversion = "0"\n[tool.pytest.ini_options]\npythonpath = ["."]\n',
    'tests/test_unit.py': 'def test_unit():\n    assert True\n',
    'tests/acceptance/test_smoke.py': 'def test_smoke():\n    assert True\n',
    'tests/integration/test_flow.py': 'def test_flow():\n    assert True\n',
  },
  green: {
    'calc.py': 'def add(a, b):\n    return a + b\n',
    'tests/acceptance/test_calc.py': 'from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n',
  },
  red: { 'calc.py': 'def add(a, b):\n    raise NotImplementedError("add")\n' },
  testId: 'tests.acceptance.test_calc::test_add',
  lockedTest: 'tests/acceptance/test_calc.py',
  l1Test: 'tests/test_unit.py',
  implement: { 'calc.py': 'def add(a, b):\n    return a + b\n' },
  sensitive: ['pyproject.toml', '\n# bumped\n'],
  check: 'pytest -q',
  paths: ['calc.py', 'tests/test_unit.py'],
  stubPaths: ['calc.py'],
  swallow: {
    'tests/conftest.py':
      'import pytest\n\n\n@pytest.hookimpl(hookwrapper=True)\ndef pytest_runtest_makereport(item, call):\n    outcome = yield\n    report = outcome.get_result()\n    if report.failed:\n        report.outcome = "passed"\n',
  },
  infraFiles: ['tests/conftest.py'],
};

const typescript: Stack = {
  name: 'typescript (vitest)',
  files: {
    '.gitignore': 'node_modules\n',
    'package.json': '{"name":"x","version":"0.0.0","type":"module","devDependencies":{"vitest":"*"}}\n',
    'package-lock.json': `${JSON.stringify({ name: 'x', lockfileVersion: 3, requires: true, packages: {} })}\n`,
    'src/unit.test.ts': "import { it, expect } from 'vitest';\nit('unit', () => expect(1).toBe(1));\n",
    'src/smoke.acceptance.test.ts': "import { it, expect } from 'vitest';\nit('smoke', () => expect(1).toBe(1));\n",
    'src/flow.integration.test.ts': "import { it, expect } from 'vitest';\nit('flow', () => expect(1).toBe(1));\n",
  },
  green: {
    'src/calc.ts': 'export const add = (a: number, b: number): number => a + b;\n',
    'src/calc.acceptance.test.ts':
      "import { it, expect } from 'vitest';\nimport { add } from './calc.js';\nit('adds', () => expect(add(1, 2)).toBe(3));\n",
  },
  red: {
    'src/calc.ts':
      "export const add = (a: number, b: number): number => {\n  throw new Error('not implemented');\n};\n",
  },
  testId: 'src/calc.acceptance.test.ts::adds',
  lockedTest: 'src/calc.acceptance.test.ts',
  l1Test: 'src/unit.test.ts',
  implement: { 'src/calc.ts': 'export const add = (a: number, b: number): number => a + b;\n' },
  sensitive: ['package.json', ''],
  check: 'npx vitest run',
  paths: ['src/calc.ts', 'src/unit.test.ts'],
  stubPaths: ['src/calc.ts'],
  swallow: {
    'vitest.config.ts': "export default { test: { setupFiles: ['./src/vitest.setup.ts'] } };\n",
    'src/vitest.setup.ts':
      "import { vi } from 'vitest';\nvi.mock('./calc.js', () => ({ add: (a: number, b: number) => a + b }));\n",
  },
  infraFiles: ['src/vitest.setup.ts', 'vitest.config.ts'],
  setup: dir =>
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'),
};

async function scenario(stack: Stack) {
  const dir = temp('apos-lock-e2e-');
  const home = temp('apos-lock-e2e-home-');
  const artifacts = temp('apos-lock-e2e-art-');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', ...args], {
      encoding: 'utf8',
    }).trim();
  const commit = (files: Record<string, string | null>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) rmSync(join(dir, name), { force: true });
      else {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), content);
      }
    }
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const out: string[] = [];
  const invoke = async (...args: string[]) => {
    process.exitCode = undefined;
    await runCli(['--repo', dir, ...args], {
      home,
      gate: { artifactRoot: artifacts },
      write: line => out.push(line),
      writeError: () => undefined,
      io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
    });
    return process.exitCode as number | undefined;
  };
  const said = () => out.splice(0).join('\n');
  const state = () => {
    const opened = ProjectJournal.open(dir, home);
    try {
      return opened.journal.getGoal(spec.id)!;
    } finally {
      opened.close();
    }
  };
  const human = ['--on-behalf', 'item 1'];

  commit(stack.files, 'project');
  stack.setup?.(dir);
  await invoke('init');
  await invoke('setup', 'draft');
  // The runners are what this checks; linters and scanners are not installed everywhere.
  const setup = jsonCodec.parse(readFileSync(join(dir, '.apos', 'project.yaml'), 'utf8')) as {
    parts: Record<string, { layers: Record<string, unknown> }>;
  };
  for (const part of Object.values(setup.parts)) {
    delete part.layers.L0;
    delete part.layers.L5;
  }
  const base = commit({ '.apos/project.yaml': jsonCodec.stringify(setup) }, 'setup');
  expect(await invoke('setup', 'probe', '--commit', base)).toBeUndefined();
  await invoke('setup', 'approve', '--commit', base, ...human);
  said();

  const goal = { ...spec, checks: [{ ...spec.checks[0]!, command: stack.check }] };
  writeFileSync(join(dir, 'brief.md'), sourceText);
  writeFileSync(join(dir, '.git', 'info', 'exclude'), 'brief.md\ngoal.json\nplan.json\n');
  writeFileSync(join(dir, 'goal.json'), JSON.stringify(goal));
  await invoke('goal', 'create', '--file', join(dir, 'goal.json'), '--source', join(dir, 'brief.md'));
  await invoke('goal', 'approve', spec.id, '--size', 'M', '--max-minutes', '240', '--max-attempts', '5', ...human);
  await invoke('goal', 'select', spec.id, ...human);
  writeFileSync(
    join(dir, 'plan.json'),
    JSON.stringify({
      id: 'EXEC-001',
      version: 1,
      goalId: spec.id,
      goalVersion: 1,
      mode: 'solo-direct',
      approach: 'add',
      rationale: 'one owner',
      risks: [],
      baseCommit: base,
      paths: stack.paths,
      stubPaths: stack.stubPaths,
      entries: ['add'],
      acceptanceMapping: [{ acceptanceId: 'AC-1', verification: 'acceptance test' }],
      verificationStrategy: 'locked acceptance test',
    }),
  );
  await invoke('lead', 'propose', '--file', join(dir, 'plan.json'));
  await invoke('lead', 'commit', spec.id);
  expect(state().status).toBe('testing');
  said();
  return { dir, git, commit, invoke, said, state, human, base };
}

describe.each([
  ['python', python, hasPytest],
  ['typescript', typescript, hasVitest],
])('test lock flow, %s', (_label, stack, available) => {
  it.skipIf(!available)(
    `${stack.name}: tests refused while green, locked while red, then packages red/red/needs-human/green, then closed`,
    async () => {
      const p = await scenario(stack);
      const mapPath = `.apos/goals/${spec.id}/tests.json`;
      const map = JSON.stringify([{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [stack.testId] }]);

      // A package cannot be submitted before the tests are locked.
      const early = p.commit({ ...stack.implement }, 'too early');
      await expect(p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', early)).rejects.toThrow(
        /not locked yet: run `apos tests submit` first/,
      );
      p.git('reset', '-q', '--hard', p.base);

      // 1. The stub already works: the test is green at lock time and is refused, naming the test.
      const green = p.commit({ ...stack.green, [mapPath]: map }, 'tests, stub already works');
      expect(await p.invoke('tests', 'submit', spec.id, '--commit', green)).toBe(1);
      expect(p.said()).toContain(`AC-1 app.L2 ${stack.testId}: already green`);
      expect(p.state().status).toBe('testing');

      // 2. The stub says "not implemented": red for the right reason, locked.
      const locked = p.commit(stack.red, 'stub raises not implemented');
      expect(await p.invoke('tests', 'submit', spec.id, '--commit', locked)).toBeUndefined();
      expect(p.said()).toMatch(/^Locked 1 tests in 1 files on /);
      expect(p.state()).toMatchObject({ status: 'executing', testLock: { commit: locked } });
      await p.invoke('tests', 'show', spec.id);
      expect(p.said()).toContain(`AC-1 -> app.L2: ${stack.testId}`);

      const worker = (name: string, files: Record<string, string | null>) => {
        p.git('checkout', '-q', '-B', name, locked);
        return p.commit(files, name);
      };
      const submit = (commit: string) => p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', commit);

      // 3. Editing a locked test, even by a space, is red.
      const changed = readFileSync(join(p.dir, stack.lockedTest), 'utf8');
      const edited = worker('edit-locked', { ...stack.implement, [stack.lockedTest]: `${changed}\n` });
      expect(await submit(edited)).toBe(1);
      expect(p.said()).toContain(`APOS-LOCKED fail: locked test modified: ${stack.lockedTest}`);

      // 4. Deleting a unit test is red.
      const lost = worker('lose-l1', { ...stack.implement, [stack.l1Test]: null });
      expect(await submit(lost)).toBe(1);
      expect(p.said()).toMatch(/APOS-INVENTORY fail: test missing: app\.L1::/);

      // 5. A sensitive file needs a decision; an agent approves; the same commit is green and the Goal verified.
      const [sensitive, extra] = stack.sensitive;
      const before = readFileSync(join(p.dir, sensitive), 'utf8');
      const edit = worker('sensitive', {
        ...stack.implement,
        [sensitive]: stack.name.startsWith('python') ? `${before}${extra}` : before.replace('"x"', '"x2"'),
      });
      expect(await submit(edit)).toBe(3);
      expect(p.said()).toContain(`APOS-SCOPE needs-human: sensitive files changed, a decision is needed: ${sensitive}`);
      const approve = (kind: string) =>
        p.invoke(
          'exception',
          'approve',
          spec.id,
          '--kind',
          kind,
          '--ref',
          'WP-MAIN',
          '--reason',
          'reviewed the change',
          '--by',
          'agent:lead',
        );
      await approve('needs-human');
      // pyproject.toml configures pytest too: it is test infrastructure as well, and needs its own approval.
      if (stack.name.startsWith('python')) {
        p.said();
        expect(await submit(edit)).toBe(3);
        expect(p.said()).toContain('hạ tầng test bị sửa: pyproject.toml');
        await approve('tests-infra');
      }
      p.said();
      expect(await submit(edit)).toBe(0);
      expect(p.said()).toContain(`WP-MAIN green on ${edit}; ${spec.id} verified`);
      expect(p.state().status).toBe('verified');
      expect(p.state().exceptions?.every(item => item.by === 'agent:lead')).toBe(true);

      await p.invoke('outcome', 'close', spec.id, ...p.human);
      expect(p.state().status).toBe('closed');
    },
    600_000,
  );

  it.skipIf(!available)(
    `${stack.name}: a package with wide paths that adds test infrastructure swallowing the failure of the locked test is not green`,
    async () => {
      const p = await scenario({ ...stack, paths: ['**'] });
      const mapPath = `.apos/goals/${spec.id}/tests.json`;
      const map = JSON.stringify([{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [stack.testId] }]);
      const locked = p.commit(
        { ...stack.green, ...stack.red, [mapPath]: map },
        'tests and a stub that is not implemented',
      );
      expect(await p.invoke('tests', 'submit', spec.id, '--commit', locked)).toBeUndefined();
      p.said();

      // Nothing is implemented; the stub still raises. The infrastructure turns that failure into a pass.
      p.git('checkout', '-q', '-B', 'cheat', locked);
      const cheat = p.commit(stack.swallow, 'swallow the failure');
      expect(await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', cheat)).toBe(3);
      const said = p.said();
      for (const file of stack.infraFiles) expect(said).toContain(file);
      expect(said).toContain('APOS-INFRA needs-human: hạ tầng test bị sửa:');
      const gate = p.state().packages?.['WP-MAIN']?.gate;
      // The locked test did read green, which is exactly why the infrastructure has to be judged.
      expect(gate?.checks.find(check => check.checkId === 'APOS-LOCKED')?.status).toBe('pass');
      expect(gate?.result).toBe('needs-human');
      expect(p.state().status).toBe('executing');

      // The decision is the approver's, and it is in the report.
      const approve = (kind: string, reason: string) =>
        p.invoke(
          'exception',
          'approve',
          spec.id,
          '--kind',
          kind,
          '--ref',
          'WP-MAIN',
          '--reason',
          reason,
          '--by',
          'agent:lead',
        );
      await approve('tests-infra', 'not a cheat');
      p.said();
      let code = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', cheat);
      if (code === 3) {
        // A runner config file is a sensitive file as well (needsHuman): it needs its own approval.
        await approve('needs-human', 'config reviewed');
        code = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', cheat);
      }
      expect(code).toBe(0);
      expect(
        p.state().packages?.['WP-MAIN']?.gate?.checks.find(check => check.checkId === 'APOS-INFRA')?.reason,
      ).toMatch(/^hạ tầng test bị sửa: .*, duyệt bởi agent:lead: not a cheat$/);
    },
    600_000,
  );
});
