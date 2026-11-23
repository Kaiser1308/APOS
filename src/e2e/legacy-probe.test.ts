import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runCli } from '../cli.js';
import { yamlCodec } from '../domain/setup-codec.js';
import { ProjectJournal } from '../store/journal.js';
import { hasVitest } from './layers-scenario.test-support.js';

/**
 * The probe of a TypeScript repo with no test file, with real vitest and the catalog's own commands: "No test files
 * found" is `no-tests`, and approving it takes `--baseline-missing`. A tool that is broken (a config that does not load)
 * is still a failed probe. Skipped when vitest is not installed.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function legacyTypescript(extra: Record<string, string> = {}) {
  const temp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  const dir = temp('apos-legacy-ts-');
  const home = temp('apos-legacy-ts-home-');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', ...args], {
      encoding: 'utf8',
    }).trim();
  const files: Record<string, string> = {
    '.gitignore': 'node_modules\n',
    'package.json': '{"name":"x","version":"0.0.0","type":"module","devDependencies":{"vitest":"*"}}\n',
    'package-lock.json': `${JSON.stringify({ name: 'x', lockfileVersion: 3, requires: true, packages: {} })}\n`,
    'src/legacy.ts': 'export const double = (n: number): number => n * 2;\n',
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git('add', '-A');
  git('commit', '-qm', 'the project today');
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const run = async (...args: string[]) => {
    const out: string[] = [];
    process.exitCode = undefined;
    try {
      await runCli(['--repo', dir, ...args], {
        home,
        gate: { artifactRoot: temp('apos-legacy-ts-art-') },
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
    return { code: code ?? 0, text: out.join('\n') };
  };
  await run('init');
  await run('setup', 'draft');
  const setup = yamlCodec.parse(readFileSync(join(dir, '.apos', 'project.yaml'), 'utf8')) as {
    parts: Record<string, { layers: Record<string, unknown> }>;
  };
  // No linter or scanner on this machine to probe: the vitest layers of the catalog are what is under test.
  delete setup.parts.app!.layers.L0;
  delete setup.parts.app!.layers.L5;
  writeFileSync(join(dir, '.apos', 'project.yaml'), yamlCodec.stringify(setup));
  git('add', '-A');
  git('commit', '-qm', 'setup');
  return { dir, home, run, commit: git('rev-parse', 'HEAD') };
}

describe.skipIf(!hasVitest)('probe of a TypeScript repo with no test', () => {
  it('reads vitest "No test files found" as no-tests, and approves it only with --baseline-missing', async () => {
    const p = await legacyTypescript();
    const probed = await p.run('setup', 'probe', '--commit', p.commit);
    expect(probed.code).toBe(0);
    for (const layer of ['L1', 'L2', 'L3'])
      expect(probed.text, layer).toMatch(new RegExp(`none app\\.${layer} vitest[\\w-]*: the tool reports no tests`));
    expect(probed.text).toContain('probe passed');

    const refused = await p.run('setup', 'approve', '--commit', p.commit, '--on-behalf', 'x');
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('--baseline-missing');
    const approved = await p.run('setup', 'approve', '--commit', p.commit, '--baseline-missing', '--on-behalf', 'x');
    expect(approved.code).toBe(0);
    expect(approved.text).toContain('BẢO ĐẢM THẤP: repo chưa có test nền (app.L1, app.L2, app.L3)');
    const opened = ProjectJournal.open(p.dir, p.home);
    try {
      expect(opened.journal.setupHistory().latest).toMatchObject({
        assurance: 'baseline-missing',
        baselineMissing: ['app.L1', 'app.L2', 'app.L3'],
      });
    } finally {
      opened.close();
    }
  }, 180_000);

  it('still fails the probe when vitest is broken and still writes an empty report: a globalSetup that throws', async () => {
    // vitest exits 1, writes the same empty junit report and even prints "No test files found", but it also prints the error.
    const p = await legacyTypescript({
      'vitest.config.ts': 'export default { test: { globalSetup: ["./global-setup.ts"] } };\n',
      'global-setup.ts': 'throw new Error("boom in the global setup");\n',
      'src/legacy.test.ts': "import { it } from 'vitest';\nit('doubles', () => undefined);\n",
    });
    const probed = await p.run('setup', 'probe', '--commit', p.commit);
    expect(probed.code).toBe(1);
    expect(probed.text).toMatch(/FAIL app\.L1/);
    expect(probed.text).not.toMatch(/none app\.L1/);
  }, 180_000);

  it('still fails the probe when vitest is broken, not empty: a config that does not load', async () => {
    const p = await legacyTypescript({ 'vitest.config.ts': 'export default {{{ not typescript\n' });
    const probed = await p.run('setup', 'probe', '--commit', p.commit);
    expect(probed.code).toBe(1);
    expect(probed.text).toMatch(/FAIL app\.L1/);
    expect(probed.text).not.toContain('no tests');
  }, 180_000);
});
