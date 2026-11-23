import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSetup, recordProbe, type ProbeReport } from './setup-probe.js';
import { prepareApproval, recordApproval } from './setup-approve.js';
import { ProjectJournal } from '../store/journal.js';
import { newEvent } from './events.js';
import { initProject } from './init-project.js';
import { jsonCodec } from '../domain/setup-codec.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** argv: out mode. `empty5`: no test, exit 5. `empty4`: no test, exit 4. `text`: says so, writes no report. `crash`: exit 1, no report. `ok`: two tests. */
const tool = `
const fs = require('fs');
const [out, mode] = process.argv.slice(2);
const suite = n => '<testsuite name="s">' + Array.from({ length: n }, (_, i) => '<testcase classname="s" name="t' + i + '"/>').join('') + '</testsuite>';
if (mode === 'empty5' || mode === 'empty4') { fs.writeFileSync(out, suite(0)); process.exit(mode === 'empty5' ? 5 : 4); }
if (mode === 'text') { console.log('No test files found, exiting with code 1'); process.exit(1); }
if (mode === 'crash') { console.error('Error: cannot load the config'); process.exit(1); }
if (mode === 'ran5') { fs.writeFileSync(out, suite(2)); process.exit(5); }
fs.writeFileSync(out, suite(2));
`;

const tests = (extra: Record<string, unknown> = {}) => ({
  paths: ['tests/**'],
  assertPatterns: [],
  notImplementedPatterns: [],
  loadErrorPatterns: [],
  noTestsExitCodes: [5],
  noTestsPatterns: ['No test files found'],
  ...extra,
});

async function repoWith(modes: Record<string, string>, testsBlock: Record<string, unknown> | null = tests()) {
  const dir = temp('apos-nt-repo-');
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  writeFileSync(join(dir, 'tool.js'), tool);
  const layers = Object.fromEntries(
    Object.entries(modes).map(([layer, mode]) => [
      layer,
      [{ id: `t-${layer.toLowerCase()}`, command: `node tool.js {report} ${mode}`, format: 'junit' }],
    ]),
  );
  const setup = {
    schemaVersion: 2,
    parts: { app: { root: '.', layers, needsHuman: [], forbid: [], ...(testsBlock ? { tests: testsBlock } : {}) } },
  };
  writeFileSync(join(dir, '.apos', 'project.yaml'), jsonCodec.stringify(setup));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', ...args], {
      encoding: 'utf8',
    }).trim();
  git('add', '-A');
  git('commit', '-qm', 'setup');
  return { dir, git, commit: git('rev-parse', 'HEAD') };
}
const deps = () => ({ codec: jsonCodec, artifactRoot: temp('apos-nt-art-') });
const open = (dir: string) => ProjectJournal.open(dir, temp('apos-nt-home-'), newEvent);

describe('probe: no tests is not a broken tool', () => {
  it('reads the declared exit code with an empty report as no-tests, and the probe still passes', async () => {
    const { dir, commit } = await repoWith({ L1: 'empty5', L2: 'empty5' });
    const report = await probeSetup(dir, commit, deps());
    expect(report.ok).toBe(true);
    expect(report.results.filter(item => item.layer !== 'tests')).toEqual([
      {
        part: 'app',
        layer: 'L1',
        tool: 't-l1',
        ok: true,
        outcome: 'no-tests',
        reason: expect.stringContaining('exit 5') as unknown,
      },
      {
        part: 'app',
        layer: 'L2',
        tool: 't-l2',
        ok: true,
        outcome: 'no-tests',
        reason: expect.stringContaining('exit 5') as unknown,
      },
    ]);
  }, 90_000);
  it('reads the words of the tool (vitest: "No test files found") when it writes no report', async () => {
    const { dir, commit } = await repoWith({ L1: 'text' });
    const report = await probeSetup(dir, commit, deps());
    expect(report.results[0]).toMatchObject({ ok: true, outcome: 'no-tests' });
  }, 60_000);
  it('keeps every other failure a failure: another exit code, a crash, a missing command', async () => {
    for (const [mode, expected] of [
      ['empty4', /holds no test/],
      ['crash', /report unreadable/],
    ] as const) {
      const { dir, commit } = await repoWith({ L1: mode });
      const report = await probeSetup(dir, commit, deps());
      expect(report.ok, mode).toBe(false);
      expect(report.results[0], mode).toMatchObject({ ok: false, reason: expect.stringMatching(expected) as unknown });
      expect(report.results[0]?.outcome, mode).toBeUndefined();
    }
    const { dir, commit } = await repoWith({});
    writeFileSync(
      join(dir, '.apos', 'project.yaml'),
      jsonCodec.stringify({
        schemaVersion: 2,
        parts: {
          app: {
            root: '.',
            layers: { L1: [{ id: 'ghost', command: 'apos-no-such-command-xyz {report}', format: 'junit' }] },
            needsHuman: [],
            forbid: [],
            tests: tests(),
          },
        },
      }),
    );
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', ...args], {
        encoding: 'utf8',
      }).trim();
    git('commit', '-qam', 'ghost');
    const ghost = await probeSetup(dir, git('rev-parse', 'HEAD'), deps());
    expect(ghost.ok).toBe(false);
    expect(ghost.results[0]?.reason).toMatch(/command not found/);
    expect(commit).toBeTruthy();
  }, 120_000);
  it('does not read a signal when the report holds tests, or when the stack declares none', async () => {
    const ran = await repoWith({ L1: 'ran5' });
    expect((await probeSetup(ran.dir, ran.commit, deps())).results[0]?.outcome).toBeUndefined();
    const silent = await repoWith({ L1: 'empty5' }, null);
    const report = await probeSetup(silent.dir, silent.commit, deps());
    expect(report.ok).toBe(false);
    expect(report.results[0]?.reason).toMatch(/holds no test/);
    const bare = await repoWith({ L1: 'empty5' }, tests({ noTestsExitCodes: [], noTestsPatterns: [] }));
    expect((await probeSetup(bare.dir, bare.commit, deps())).ok).toBe(false);
  }, 120_000);
});

describe('approving a setup with no tests', () => {
  const noTests = (layer: string): ProbeReport['results'][number] => ({
    part: 'app',
    layer,
    tool: 't',
    ok: true,
    outcome: 'no-tests',
    reason: 'the tool reports no tests',
  });
  it('is refused without --baseline-missing, and says what to run', async () => {
    const { dir, commit } = await repoWith({ L1: 'empty5' });
    const { journal, close } = open(dir);
    try {
      recordProbe(journal, commit, await probeSetup(dir, commit, deps()));
      expect(() => prepareApproval(journal, dir, commit, jsonCodec)).toThrow(
        /apos setup approve --commit \w+ --baseline-missing/,
      );
      expect(() => prepareApproval(journal, dir, commit, jsonCodec)).toThrow(/app\.L1/);
    } finally {
      close();
    }
  }, 90_000);
  it('with the flag, writes assurance: baseline-missing and the layers that have no tests', async () => {
    const { dir, commit } = await repoWith({ L1: 'empty5', L2: 'empty5' });
    const { journal, close } = open(dir);
    try {
      recordProbe(journal, commit, await probeSetup(dir, commit, deps()));
      const pending = prepareApproval(journal, dir, commit, jsonCodec, { baselineMissing: true });
      expect(pending.baselineMissing).toEqual(['app.L1', 'app.L2']);
      recordApproval(journal, pending, { by: 'on-behalf', onBehalf: 'demo' });
      // The fields survive the log: replaying it gives them back.
      expect(journal.setupHistory().latest).toMatchObject({
        version: 1,
        assurance: 'baseline-missing',
        baselineMissing: ['app.L1', 'app.L2'],
      });
    } finally {
      close();
    }
  }, 90_000);
  it('refuses the flag when the probe found tests everywhere: the label would be false', async () => {
    const { dir, commit } = await repoWith({ L1: 'ok' });
    const { journal, close } = open(dir);
    try {
      recordProbe(journal, commit, await probeSetup(dir, commit, deps()));
      expect(() => prepareApproval(journal, dir, commit, jsonCodec, { baselineMissing: true })).toThrow(
        /--baseline-missing/,
      );
      expect(prepareApproval(journal, dir, commit, jsonCodec).baselineMissing).toBeUndefined();
    } finally {
      close();
    }
  }, 90_000);
  it('the log itself refuses an approval of a no-tests probe that does not carry the label', async () => {
    const { dir, commit } = await repoWith({ L1: 'ok' });
    const { journal, close } = open(dir);
    try {
      const real = await probeSetup(dir, commit, deps());
      recordProbe(journal, commit, { ...real, results: [noTests('L1')] });
      expect(() => recordApproval(journal, { commit, sha256: real.sha256, version: 1 }, { by: 'human' })).toThrow(
        /baseline-missing/,
      );
    } finally {
      close();
    }
  }, 90_000);
  it('the label goes only when a new setup version is approved on a probe that sees tests, even for the same text', async () => {
    const { dir, git, commit: first } = await repoWith({ L1: 'empty5' });
    const { journal, close } = open(dir);
    try {
      recordProbe(journal, first, await probeSetup(dir, first, deps()));
      recordApproval(journal, prepareApproval(journal, dir, first, jsonCodec, { baselineMissing: true }), {
        by: 'human',
      });
      // The same text again, probed where there is still nothing to run: nothing changes.
      git('commit', '--allow-empty', '-qm', 'still no tests');
      const second = git('rev-parse', 'HEAD');
      recordProbe(journal, second, await probeSetup(dir, second, deps()));
      expect(() => prepareApproval(journal, dir, second, jsonCodec, { baselineMissing: true })).toThrow(
        /already approved/,
      );
      // Tests exist now (the tool reports two): the same text is approved again as version 2, with no label.
      writeFileSync(
        join(dir, 'tool.js'),
        tool.replace("if (mode === 'empty5'", "if (false && mode === 'empty5'") + 'fs.writeFileSync(out, suite(2));\n',
      );
      git('add', '-A');
      git('commit', '-qm', 'tests arrived');
      const third = git('rev-parse', 'HEAD');
      const report = await probeSetup(dir, third, deps());
      expect(report.results[0]?.outcome).toBeUndefined();
      recordProbe(journal, third, report);
      const pending = prepareApproval(journal, dir, third, jsonCodec);
      expect(pending).toMatchObject({ version: 2 });
      recordApproval(journal, pending, { by: 'human' });
      expect(journal.setupHistory().latest?.assurance).toBeUndefined();
      expect(journal.setupHistory().approvals[0]?.assurance).toBe('baseline-missing');
    } finally {
      close();
    }
  }, 120_000);
});
