import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { jsonCodec } from '../domain/setup-codec.js';

const dirs: string[] = [];
const saved = process.env.APOS_HOME;
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-flow-home-');
});
afterEach(() => {
  if (saved === undefined) delete process.env.APOS_HOME;
  else process.env.APOS_HOME = saved;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const report =
  'require(\'fs\').writeFileSync(process.argv[2],\'<testsuite name="s"><testcase classname="s" name="a"/></testsuite>\');';

it('drafts, probes and approves a setup; approval is a Human decision; a setup edited after its probe is refused', async () => {
  const dir = temp('apos-flow-repo-');
  execFileSync('git', ['init', '-q', dir]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', ...args], {
      encoding: 'utf8',
    }).trim();
  const home = temp('apos-flow-ctl-');
  const out: string[] = [];
  const err: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], {
      home,
      write: line => out.push(line),
      writeError: line => err.push(line),
      io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
    });
  await expect(invoke('setup', 'draft')).rejects.toThrow(/apos init first/);
  await invoke('init');
  writeFileSync(join(dir, 'package.json'), '{"devDependencies":{"vitest":"^4"}}');
  await invoke('setup', 'draft');
  expect(out.join('\n')).toMatch(/Wrote .apos\/project.yaml: app/);
  const drafted = JSON.parse(readFileSync(join(dir, '.apos', 'project.yaml'), 'utf8')) as {
    parts: { app: { stack: string } };
  };
  expect(drafted.parts.app.stack).toBe('typescript');
  await expect(invoke('setup', 'draft')).rejects.toThrow(/already has a v2 setup/);
  await invoke('setup', 'draft', '--force');

  writeFileSync(join(dir, 'report.js'), report);
  const setup = (id: string) =>
    jsonCodec.stringify({
      schemaVersion: 2,
      parts: {
        app: {
          root: '.',
          layers: { L1: [{ id, command: 'node report.js {report}', format: 'junit' }] },
          needsHuman: [],
          forbid: [],
        },
      },
    });
  writeFileSync(join(dir, '.apos', 'project.yaml'), setup('t1'));
  git('add', '-A');
  git('commit', '-qm', 'setup');
  const first = git('rev-parse', 'HEAD');

  await expect(invoke('setup', 'approve', '--commit', first)).rejects.toThrow(/Chưa probe ở commit này/);
  await invoke('setup', 'probe', '--commit', first);
  expect(out.join('\n')).toMatch(/ok {3}app.L1 t1: 1 tests, stable over 2 runs/);
  expect(out.join('\n')).toMatch(/probe passed/);
  await expect(invoke('setup', 'approve', '--commit', first)).rejects.toThrow(/Human decision/);
  await invoke('setup', 'approve', '--commit', first, '--on-behalf', 'item 3');
  await invoke('setup', 'show');
  expect(out.at(-1)).toMatch(/^setup v1 sha256 [0-9a-f]{64} commit [0-9a-f]{40}$/);

  writeFileSync(join(dir, '.apos', 'project.yaml'), setup('t2'));
  git('add', '-A');
  git('commit', '-qm', 'edit');
  await expect(invoke('setup', 'approve', '--commit', 'HEAD', '--on-behalf', 'item 3')).rejects.toThrow(
    /Chưa probe ở commit này/,
  );
}, 120_000);
