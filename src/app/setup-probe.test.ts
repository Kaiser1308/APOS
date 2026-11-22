import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSetup, recordProbe } from './setup-probe.js';
import { prepareApproval, recordApproval } from './setup-approve.js';
import { ProjectJournal } from '../store/journal.js';
import { newEvent } from './events.js';
import { initProject } from './init-project.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { STACKS } from '../domain/catalog-stacks.test-support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** argv: out mode [name]. Modes: ok, none (nothing ran), wrong (another test ran), two (runOne ran two), broken, empty, flaky. */
const tool = `
const fs = require('fs');
const [out, mode, rawName, counter] = process.argv.slice(2);
const name = rawName === '-' ? '' : rawName;
const tc = (n, extra = '') => '<testcase classname="suite" name="' + n + '">' + extra + '</testcase>';
const skip = n => tc(n, '<skipped/>');
let cases;
if (mode === 'broken') cases = '<testcase';
else if (mode === 'empty') cases = '';
else if (mode === 'second-broken' || mode === 'second-missing') {
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  if (n >= 1 && mode === 'second-missing') process.exit(0);
  cases = n >= 1 ? '<testcase' : tc('a') + tc('b');
}
else if (mode === 'allerr') cases = '<testcase classname="tests.acceptance.test_calc" name="tests.acceptance.test_calc"><error message="collection failure"/></testcase>';
else if (mode === 'loaderr') cases = tc('a') + '<testcase classname="m" name="mod"><error message="ImportError while importing test module"/></testcase>';
else if (name) {
  if (mode === 'none') cases = skip('a') + skip('b');
  else if (mode === 'wrong') cases = tc('b') + skip('a');
  else if (mode === 'two') cases = tc('a') + tc('b');
  else cases = (name === 'a' ? tc('a') : skip('a')) + (name === 'b' ? tc('b') : skip('b'));
} else if (mode === 'flaky') {
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  cases = tc('a', n % 2 ? '<failure message="x"/>' : '') + tc('b');
} else cases = tc('a') + tc('b');
fs.writeFileSync(out, mode === 'broken' || (mode === 'second-broken' && cases === '<testcase') ? '<testsuite>' + cases : '<testsuite name="suite">' + cases + '</testsuite>');
`;

async function repoWith(
  layers: Record<string, unknown[]>,
  extra: Record<string, unknown> = {},
  part: Record<string, unknown> = {},
) {
  const dir = temp('apos-probe-repo-');
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  writeFileSync(join(dir, 'tool.js'), tool);
  const setup = {
    schemaVersion: 2,
    parts: { app: { root: '.', layers, needsHuman: [], forbid: [], ...part } },
    ...extra,
  };
  writeFileSync(join(dir, '.apos', 'project.yaml'), jsonCodec.stringify(setup));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'setup');
  return { dir, git, commit: git('rev-parse', 'HEAD') };
}
const deps = () => ({ codec: jsonCodec, artifactRoot: temp('apos-probe-art-') });
const junit = (mode: string, extra: Record<string, unknown> = {}) => ({
  id: 't',
  command: `node tool.js {report} ${mode}`,
  format: 'junit',
  ...extra,
});

describe('probeSetup test patterns', () => {
  it('fails the probe when a regex of the tests block does not compile, and names it', async () => {
    const { dir, commit } = await repoWith(
      { L1: [junit('ok')] },
      {},
      {
        tests: { paths: ['tests/**'], assertPatterns: ['assert('], notImplementedPatterns: [], loadErrorPatterns: [] },
      },
    );
    const report = await probeSetup(dir, commit, deps());
    expect(report.ok).toBe(false);
    expect(report.results.find(item => item.layer === 'tests')).toMatchObject({
      part: 'app',
      tool: 'patterns',
      ok: false,
      reason: expect.stringContaining('assert(') as unknown,
    });
  }, 90_000);
  it('does not count the pattern row as a tool: a part with tests and no layer still proves nothing', async () => {
    const { dir, commit } = await repoWith(
      {},
      {},
      { tests: { paths: ['tests/**'], assertPatterns: [], notImplementedPatterns: [], loadErrorPatterns: [] } },
    );
    const report = await probeSetup(dir, commit, deps());
    expect(report.results.map(item => item.layer)).toEqual(['tests']);
    expect(report.ok).toBe(false);
  }, 90_000);
  it('passes patterns that compile and says where the tests are', async () => {
    const { dir, commit } = await repoWith(
      { L1: [junit('ok')] },
      {},
      {
        tests: {
          paths: ['tests/**'],
          assertPatterns: ['\\bassert\\b'],
          notImplementedPatterns: ['NIE'],
          loadErrorPatterns: [],
        },
      },
    );
    const report = await probeSetup(dir, commit, deps());
    expect(report.ok).toBe(true);
    expect(report.results.find(item => item.layer === 'tests')?.reason).toBe(
      '2 patterns compile; tests under tests/**',
    );
  }, 90_000);
});

describe('probeSetup', () => {
  it('passes a junit tool whose runOne runs exactly one test and whose two runs agree', async () => {
    const { dir, commit } = await repoWith({
      L1: [junit('ok', { runOne: 'node tool.js {report} ok "{name}"' })],
    });
    const report = await probeSetup(dir, commit, deps());
    expect(report.ok).toBe(true);
    expect(report.results).toEqual([
      { part: 'app', layer: 'L1', tool: 't', ok: true, reason: '2 tests, runOne ok, stable over 2 runs' },
    ]);
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 90_000);
  it('fails and names the test when runOne ran two tests, none, or another one', async () => {
    for (const [mode, expected] of [
      ['two', /runOne for suite::a ran 2 tests: suite::a, suite::b/],
      ['none', /runOne for suite::a ran 0 tests/],
      ['wrong', /runOne for suite::a ran suite::b instead/],
    ] as const) {
      const { dir, commit } = await repoWith({
        L2: [junit('ok', { runOne: `node tool.js {report} ${mode} "{name}"` })],
      });
      const report = await probeSetup(dir, commit, deps());
      expect(report.ok, mode).toBe(false);
      expect(report.results[0]?.reason, mode).toMatch(expected);
    }
  }, 120_000);
  it('fails on a truncated report and on a report with no test', async () => {
    for (const [mode, expected] of [
      ['broken', /report unreadable/],
      ['empty', /holds no test/],
    ] as const) {
      const { dir, commit } = await repoWith({ L1: [junit(mode)] });
      const report = await probeSetup(dir, commit, deps());
      expect(report.ok, mode).toBe(false);
      expect(report.results[0]?.reason, mode).toMatch(expected);
    }
  }, 90_000);
  it('fails when two runs of L1 disagree', async () => {
    const counter = join(temp('apos-probe-counter-'), 'n').replaceAll('\\', '/');
    const { dir, commit } = await repoWith({ L1: [junit(`flaky - ${counter}`)] });
    const report = await probeSetup(dir, commit, deps());
    expect(report.ok).toBe(false);
    expect(report.results[0]?.reason).toMatch(/flaky/);
  }, 90_000);
  it('fails when the second run of L1 gives an unreadable or missing report, even with the same exit code', async () => {
    for (const mode of ['second-broken', 'second-missing']) {
      const counter = join(temp('apos-probe-counter-'), 'n').replaceAll('\\', '/');
      const { dir, commit } = await repoWith({ L1: [junit(`${mode} - ${counter}`)] });
      const report = await probeSetup(dir, commit, deps());
      expect(report.ok, mode).toBe(false);
      expect(report.results[0]?.reason, mode).toMatch(/second run report unusable/);
    }
  }, 120_000);
  it('fails when the command does not exist or times out', async () => {
    const { dir, commit } = await repoWith({
      L1: [{ id: 'ghost', command: 'apos-no-such-command-xyz --junit {report}', format: 'junit' }],
      L2: [{ id: 'slow', command: 'node -e "setInterval(()=>{},1000)"', format: 'exit' }],
    });
    const report = await probeSetup(dir, commit, { ...deps(), timeoutMs: 2000 });
    expect(report.ok).toBe(false);
    expect(report.results.map(r => r.reason)).toEqual([
      expect.stringMatching(/command not found/),
      expect.stringMatching(/timed out/),
    ]);
  }, 90_000);
  it('accepts an exit-only tool even when it exits non-zero, as long as it runs', async () => {
    const { dir, commit } = await repoWith({
      L0: [{ id: 'lint', command: 'node -e "process.exit(1)"', format: 'exit' }],
    });
    const report = await probeSetup(dir, commit, deps());
    expect(report.results[0]).toMatchObject({ ok: true });
    expect(report.results[0]?.reason).toMatch(/only the exit code/);
  }, 60_000);
  it('probes system layers and reads the report glob of a tool without {report}', async () => {
    const { dir, commit } = await repoWith(
      {},
      {
        system: {
          L4: [
            {
              id: 'e2e',
              command: "node -e \"require('fs').mkdirSync('out')\" && node tool.js out/r.xml ok",
              format: 'junit',
              report: 'out/*.xml',
            },
          ],
        },
      },
    );
    const report = await probeSetup(dir, commit, deps());
    expect(report.results).toMatchObject([{ part: 'system', layer: 'L4', tool: 'e2e', ok: true, reason: '2 tests' }]);
  }, 60_000);
  it('is not ok when the setup defines no tool, and refuses a repo without a v2 setup', async () => {
    const empty = await repoWith({});
    expect((await probeSetup(empty.dir, empty.commit, deps())).ok).toBe(false);
    const old = temp('apos-probe-old-');
    execFileSync('git', ['init', '-q', old]);
    mkdirSync(join(old, '.apos'));
    writeFileSync(join(old, '.apos', 'project.yaml'), 'schemaVersion: 1\n');
    execFileSync('git', ['-C', old, 'add', '-A']);
    execFileSync('git', ['-C', old, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-qm', 'v1']);
    const head = execFileSync('git', ['-C', old, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await expect(probeSetup(old, head, deps())).rejects.toThrow(/not a v2 setup/);
    await expect(probeSetup(old, 'deadbeef', deps())).rejects.toThrow(/does not exist/);
  }, 60_000);
});

describe('tests that never loaded', () => {
  it('fails when every testcase errored (pytest collection failure), with the message', async () => {
    const { dir, commit } = await repoWith({ L1: [junit('allerr')] });
    const report = await probeSetup(dir, commit, deps());
    expect(report.ok).toBe(false);
    expect(report.results[0]?.reason).toBe('tests could not load: collection failure');
  }, 60_000);
  it("fails on a load error among passing tests when the stack's loadErrorPatterns recognise it, and only then", async () => {
    const python = STACKS.find(entry => entry.stack === 'python')!;
    const { dir, commit } = await repoWith({ L1: [junit('loaderr')] }, {}, { stack: 'python' });
    const known = await probeSetup(dir, commit, { ...deps(), catalog: [python] });
    expect(known.results[0]?.reason).toBe('tests could not load: ImportError while importing test module');
    const unknown = await probeSetup(dir, commit, { ...deps(), catalog: [{ ...python, loadErrorPatterns: [] }] });
    expect(unknown.results[0]?.ok).toBe(true);
  }, 90_000);
});

describe('approving a probed setup', () => {
  it('judges by the latest probe at this commit, not by a probe of the same text elsewhere', async () => {
    const { dir, git, commit: a } = await repoWith({ L1: [junit('ok')] });
    git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '--allow-empty', '-qm', 'same setup, later');
    const b = git('rev-parse', 'HEAD');
    const { journal, close } = ProjectJournal.open(dir, temp('apos-probe-home-'), newEvent);
    try {
      const sha256 = (await probeSetup(dir, a, deps())).sha256;
      const failed = (layer: string, reason: string) => ({
        sha256,
        ok: false,
        results: [{ part: 'app', layer, tool: 't', ok: false, reason }],
      });
      recordProbe(journal, a, failed('L1', 'empty at A'));
      expect(() => prepareApproval(journal, dir, b, jsonCodec)).toThrow(/Chưa probe ở commit này/);
      recordProbe(journal, b, failed('L2', 'runOne at B'));
      expect(() => prepareApproval(journal, dir, b, jsonCodec)).toThrow(/runOne at B/);
      expect(() => prepareApproval(journal, dir, b, jsonCodec)).not.toThrow(/empty at A/);
      // A passing probe at A does not approve B, and a later failing probe at A cancels A's earlier pass.
      recordProbe(journal, a, { sha256, ok: true, results: [] });
      expect(() => prepareApproval(journal, dir, b, jsonCodec)).toThrow(/runOne at B/);
      expect(prepareApproval(journal, dir, a, jsonCodec).commit).toBe(a);
      recordProbe(journal, a, failed('L1', 'broke again'));
      expect(() => prepareApproval(journal, dir, a, jsonCodec)).toThrow(/broke again/);
    } finally {
      close();
    }
  }, 90_000);

  const open = (dir: string) => ProjectJournal.open(dir, temp('apos-probe-home-'), newEvent);
  it('needs a passing probe of exactly this text; an edit after the probe is refused', async () => {
    const { dir, git, commit } = await repoWith({ L1: [junit('ok')] });
    const { journal, close } = open(dir);
    try {
      expect(() => prepareApproval(journal, dir, commit, jsonCodec)).toThrow(/Chưa probe ở commit này/);
      recordProbe(journal, commit, await probeSetup(dir, commit, deps()));
      const pending = prepareApproval(journal, dir, commit, jsonCodec);
      expect(pending).toMatchObject({ commit, version: 1 });

      writeFileSync(
        join(dir, '.apos', 'project.yaml'),
        jsonCodec.stringify({
          schemaVersion: 2,
          parts: { app: { root: '.', layers: { L1: [junit('ok', { id: 'sneaky' })] }, needsHuman: [], forbid: [] } },
        }),
      );
      git('add', '-A');
      git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'edit after probe');
      expect(() => prepareApproval(journal, dir, 'HEAD', jsonCodec)).toThrow(/Chưa probe ở commit này/);

      recordApproval(journal, pending, { by: 'on-behalf', onBehalf: 'item 7' });
      expect(journal.setupHistory().latest).toMatchObject({
        version: 1,
        commit,
        confirmation: { by: 'on-behalf', onBehalf: 'item 7' },
      });
      expect(() => prepareApproval(journal, dir, commit, jsonCodec)).toThrow(/already approved as version 1/);
    } finally {
      close();
    }
  }, 120_000);
  it('refuses a setup whose probe failed and says why, and an unknown commit', async () => {
    const { dir, commit } = await repoWith({ L1: [junit('broken')] });
    const { journal, close } = open(dir);
    try {
      recordProbe(journal, commit, await probeSetup(dir, commit, deps()));
      expect(() => prepareApproval(journal, dir, commit, jsonCodec)).toThrow(
        /latest probe of this setup.*failed.*unreadable/,
      );
      expect(() => prepareApproval(journal, dir, 'nope', jsonCodec)).toThrow(/not a commit/);
    } finally {
      close();
    }
  }, 60_000);
});
