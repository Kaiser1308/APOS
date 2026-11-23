import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runCli } from '../cli.js';
import { yamlCodec } from '../domain/setup-codec.js';
import { controllerHome } from '../store/event-log.js';
import { ProjectJournal } from '../store/journal.js';
import type { GoalState } from '../domain/transitions.js';

/**
 * Shared by the phase 4 end-to-end flows: a real repo, a real test runner (pytest or vitest), the CLI. With
 * `APOS_E2E_BIN=dist/cli.js` every command runs as a separate process of the built binary instead of in-process.
 */
export const hasPytest = spawnSync('pytest', ['--version']).status === 0;
export const hasVitest = existsSync(resolve('node_modules', '.bin', 'vitest'));

const BIN = process.env.APOS_E2E_BIN ? resolve(process.env.APOS_E2E_BIN) : undefined;

const SCRIPTS = {
  // A benchmark that reports the number in perf/bench.txt, and a scanner that turns perf/findings.txt (one level per word) into SARIF.
  'scripts/bench.cjs':
    "const fs = require('fs');\nconst value = Number(fs.readFileSync('perf/bench.txt', 'utf8').trim());\nfs.writeFileSync(process.argv[2], JSON.stringify({ p95_ms: value }));\n",
  'scripts/scan.cjs':
    "const fs = require('fs');\nconst levels = fs.readFileSync('perf/findings.txt', 'utf8').split(/\\s+/).filter(Boolean);\nconst results = levels.map((level, i) => ({ ruleId: 'FAKE' + i, level, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a' }, region: { startLine: i + 1 } } }] }));\nfs.writeFileSync(process.argv[2], JSON.stringify({ runs: [{ tool: { driver: { name: 'fake' } }, results }] }));\n",
  'perf/bench.txt': '150\n',
  'perf/findings.txt': '\n',
};

export type Stack = {
  name: string;
  files: Record<string, string>;
  /** Module A and module B of a Multi-WP Goal: a stub that works, one that says "not implemented", the acceptance test, and its id. */
  modules: Record<
    'a' | 'b',
    { check: string; stub: string; red: string; done: string; test: string; testSource: string; testId: string }
  >;
  /** A page file under the path the trigger watches. */
  ui: string;
  check: string;
  paths: string[];
  setup: { l1From: string; l1To: string; l4: string };
  prepare?: (dir: string) => void;
  /** A file the integration test fails on when it exists. */
  breakFlag: string;
};

export const python: Stack = {
  name: 'python (pytest)',
  files: {
    '.gitignore': '__pycache__/\n.pytest_cache/\n',
    'pyproject.toml': '[project]\nname = "x"\nversion = "0"\n[tool.pytest.ini_options]\npythonpath = ["."]\n',
    'tests/test_unit.py': 'def test_unit():\n    assert True\n',
    'tests/acceptance/test_smoke.py': 'def test_smoke():\n    assert True\n',
    'tests/integration/test_flow.py': 'import os\n\n\ndef test_flow():\n    assert not os.path.exists("break.flag")\n',
    'e2e/test_e2e_smoke.py': 'def test_e2e_smoke():\n    assert True\n',
    ...SCRIPTS,
  },
  modules: {
    a: {
      check: 'pytest -q tests/acceptance/test_adder.py',
      stub: 'adder.py',
      red: 'def add(a, b):\n    raise NotImplementedError("add")\n',
      done: 'def add(a, b):\n    return a + b\n',
      test: 'tests/acceptance/test_adder.py',
      testSource: 'from adder import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n',
      testId: 'tests.acceptance.test_adder::test_add',
    },
    b: {
      check: 'pytest -q tests/acceptance/test_suber.py',
      stub: 'suber.py',
      red: 'def sub(a, b):\n    raise NotImplementedError("sub")\n',
      done: 'def sub(a, b):\n    return a - b\n',
      test: 'tests/acceptance/test_suber.py',
      testSource: 'from suber import sub\n\n\ndef test_sub():\n    assert sub(3, 1) == 2\n',
      testId: 'tests.acceptance.test_suber::test_sub',
    },
  },
  ui: 'src/ui/page.py',
  check: 'pytest -q',
  paths: ['adder.py', 'suber.py', 'tests/test_unit.py', 'perf/**', 'src/ui/**', 'break.flag'],
  setup: {
    l1From: '--ignore=tests/integration',
    l1To: '--ignore=tests/integration --ignore=e2e',
    l4: 'pytest -o junit_family=xunit1 e2e --junitxml={report}',
  },
  breakFlag: 'break.flag',
};

export const typescript: Stack = {
  name: 'typescript (vitest)',
  files: {
    '.gitignore': 'node_modules\n',
    'package.json': '{"name":"x","version":"0.0.0","type":"module","devDependencies":{"vitest":"*"}}\n',
    'package-lock.json': `${JSON.stringify({ name: 'x', lockfileVersion: 3, requires: true, packages: {} })}\n`,
    'src/unit.test.ts': "import { it, expect } from 'vitest';\nit('unit', () => expect(1).toBe(1));\n",
    'src/smoke.acceptance.test.ts': "import { it, expect } from 'vitest';\nit('smoke', () => expect(1).toBe(1));\n",
    'src/flow.integration.test.ts':
      "import { it, expect } from 'vitest';\nimport { existsSync } from 'node:fs';\nit('flow', () => expect(existsSync('break.flag')).toBe(false));\n",
    'src/smoke.e2e.test.ts': "import { it, expect } from 'vitest';\nit('e2e smoke', () => expect(1).toBe(1));\n",
    ...SCRIPTS,
  },
  modules: {
    a: {
      check: 'npx vitest run adder.acceptance',
      stub: 'src/adder.ts',
      red: "export const add = (a: number, b: number): number => {\n  throw new Error('not implemented');\n};\n",
      done: 'export const add = (a: number, b: number): number => a + b;\n',
      test: 'src/adder.acceptance.test.ts',
      testSource:
        "import { it, expect } from 'vitest';\nimport { add } from './adder.js';\nit('adds', () => expect(add(1, 2)).toBe(3));\n",
      testId: 'src/adder.acceptance.test.ts::adds',
    },
    b: {
      check: 'npx vitest run suber.acceptance',
      stub: 'src/suber.ts',
      red: "export const sub = (a: number, b: number): number => {\n  throw new Error('not implemented');\n};\n",
      done: 'export const sub = (a: number, b: number): number => a - b;\n',
      test: 'src/suber.acceptance.test.ts',
      testSource:
        "import { it, expect } from 'vitest';\nimport { sub } from './suber.js';\nit('subs', () => expect(sub(3, 1)).toBe(2));\n",
      testId: 'src/suber.acceptance.test.ts::subs',
    },
  },
  ui: 'src/ui/page.ts',
  check: 'npx vitest run',
  paths: ['src/adder.ts', 'src/suber.ts', 'src/unit.test.ts', 'perf/**', 'src/ui/**', 'break.flag'],
  setup: {
    l1From: '{acceptance,integration}',
    l1To: '{acceptance,integration,e2e}',
    l4: 'npx vitest run e2e.test --reporter=junit --outputFile={report}',
  },
  prepare: dir =>
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'),
  breakFlag: 'break.flag',
};

export type Said = { code: number | undefined; text: string };

/** A repo with the stack's files, a drafted setup edited for the scenario, probed and approved by the Human. */
export function openProject(stack: Stack, cleanup: string[]) {
  const temp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
  };
  const dir = temp('apos-layers-e2e-');
  const home = temp('apos-layers-e2e-home-');
  const artifacts = temp('apos-layers-e2e-art-');
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
  /** Runs one command and says what it printed and which exit code it left; a refusal is a code of 1 and its message. */
  const invoke = async (...args: string[]): Promise<Said> => {
    const said = await run(...args);
    // APOS_E2E_TRANSCRIPT=<file> keeps what every command printed, for a reader of the real run.
    if (process.env.APOS_E2E_TRANSCRIPT)
      appendFileSync(
        process.env.APOS_E2E_TRANSCRIPT,
        `$ apos ${args.join(' ').replaceAll(dir, '<repo>')}  # exit ${said.code ?? 0}\n${said.text.replaceAll(dir, '<repo>')}\n`,
      );
    return said;
  };
  const run = async (...args: string[]): Promise<Said> => {
    if (BIN) {
      const done = spawnSync(process.execPath, [BIN, '--repo', dir, ...args], {
        encoding: 'utf8',
        env: { ...process.env, APOS_HOME: home, APOS_ARTIFACTS: artifacts, NODE_NO_WARNINGS: '1' },
      });
      return { code: done.status ?? undefined, text: `${done.stdout}${done.stderr}` };
    }
    const out: string[] = [];
    process.exitCode = undefined;
    try {
      await runCli(['--repo', dir, ...args], {
        home,
        gate: { artifactRoot: artifacts },
        write: line => out.push(line),
        writeError: line => out.push(line),
        io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
      });
    } catch (error) {
      out.push(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    const code = process.exitCode as number | undefined;
    process.exitCode = undefined;
    return { code, text: out.join('\n') };
  };
  const state = (goalId: string): GoalState => {
    // The built binary keeps its state under `<APOS_HOME>/projects/<key>`, the in-process run directly in `home`.
    const opened = ProjectJournal.open(dir, BIN ? controllerHome(dir, home) : home);
    try {
      return opened.journal.getGoal(goalId)!;
    } finally {
      opened.close();
    }
  };
  const human = ['--on-behalf', 'item 1'];
  const json = (name: string, value: unknown) => {
    writeFileSync(join(dir, '.git', 'info', 'exclude'), 'brief.md\n*.plan.json\n', { flag: 'a' });
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };

  /** Draft, then edit as the scenario needs: no linters, benchmark and scan tools, an e2e tool on `system`. */
  const setUp = async (edit?: (app: { layers: Record<string, unknown[]> }) => void) => {
    commit(stack.files, 'project');
    stack.prepare?.(dir);
    await invoke('init');
    await invoke('setup', 'draft');
    const setup = yamlCodec.parse(readFileSync(join(dir, '.apos', 'project.yaml'), 'utf8')) as {
      parts: Record<string, { layers: Record<string, { command: string }[]> }>;
      system?: unknown;
      triggers?: unknown;
    };
    const app = setup.parts.app!;
    delete app.layers.L0;
    app.layers.L1![0]!.command = app.layers.L1![0]!.command.replace(stack.setup.l1From, stack.setup.l1To);
    app.layers.L5 = [
      {
        id: 'bench',
        command: 'node scripts/bench.cjs {report}',
        format: 'metric',
        metric: 'p95_ms',
        when: 'flag:perf',
      },
      { id: 'scan', command: 'node scripts/scan.cjs {report}', format: 'sarif' },
    ] as never;
    edit?.(app as { layers: Record<string, unknown[]> });
    setup.system = { L4: [{ id: 'e2e', command: stack.setup.l4, format: 'junit' }] };
    setup.triggers = [{ when: { changed: ['src/ui/**'] }, at: 'submit', run: ['system.L4'] }];
    const base = commit({ '.apos/project.yaml': yamlCodec.stringify(setup) }, 'setup');
    const probe = await invoke('setup', 'probe', '--commit', base);
    if (probe.code) throw new Error(`the probe failed: ${probe.text}`);
    const approved = await invoke('setup', 'approve', '--commit', base, ...human);
    if (approved.code) throw new Error(`the approval failed: ${approved.text}`);
    return base;
  };
  return { dir, git, commit, invoke, state, human, json, setUp };
}
