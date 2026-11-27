import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, toCsv, assertPrivateCorpus, assertPrivateOutput } from './contract.mjs';

const sample = {
  version: 1,
  cases: [
    {
      id: 'c1',
      goalKind: 'feature',
      family: 'boundary',
      severity: 'high',
      truth: 'fault',
      expected: 'red',
      repository: 'repos/example.bundle',
      deliveryCommit: '0123456789012345678901234567890123456789',
      oracle: 'boundary violates the requirement',
      actions: [['init']],
      goalId: 'GOAL-001',
      packageId: 'WP-MAIN',
    },
  ],
};
it('accepts a fixed delivery and independently stated oracle', () => {
  assert.deepEqual(parseManifest(sample), sample);
});
it('rejects missing oracle and moving git references', () => {
  assert.throws(() =>
    parseManifest({ ...sample, cases: [{ ...sample.cases[0], oracle: '', deliveryCommit: 'main' }] }),
  );
});
it('escapes commas, quotes and newlines in CSV', () => {
  assert.equal(
    toCsv([{ caseId: 'a,b', caughtBy: 'a"b\nc' }], ['caseId', 'caughtBy']),
    'caseId,caughtBy\n"a,b","a""b\nc"\n',
  );
});

it('rejects an output directory reached through a symlink into the public checkout', async () => {
  const { mkdtempSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const temp = mkdtempSync(join(tmpdir(), 'bench-path-'));
  symlinkSync(process.cwd(), join(temp, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertPrivateOutput(process.cwd(), join(temp, 'public', 'output')));
});

it('permits a fixed clock but rejects an invalid time for deadline-sensitive cases', () => {
  const item = { ...sample.cases[0], clock: '2026-11-24T08:00:00Z' };
  assert.equal(parseManifest({ ...sample, cases: [item] }).cases[0].clock, item.clock);
  assert.throws(() => parseManifest({ ...sample, cases: [{ ...item, clock: 'tomorrow' }] }));
});

it('does not reveal private input when the manifest is malformed', async () => {
  const { readManifest } = await import('./contract.mjs');
  assert.throws(
    () => readManifest('private-manifest-content'),
    error => {
      assert.equal(error.message, 'Invalid corpus manifest');
      return true;
    },
  );
});

it('rejects private output and corpus inside a different Git repository', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const temp = mkdtempSync(join(tmpdir(), 'bench-other-repo-'));
  const other = join(temp, 'other');
  mkdirSync(other);
  execFileSync('git', ['init', '-q', other]);
  const corpus = join(other, 'private-corpus');
  mkdirSync(corpus);
  assert.throws(() => assertPrivateOutput(process.cwd(), join(other, 'private-output')));
  assert.throws(() => assertPrivateCorpus(corpus));
});

it('rejects a linked Git worktree even with Git environment overrides', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const temp = mkdtempSync(join(tmpdir(), 'bench-linked-worktree-'));
  const repo = join(temp, 'repo'),
    linked = join(temp, 'linked');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'file'), 'data');
  execFileSync('git', ['-C', repo, 'add', 'file']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'other', linked]);
  const original = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = linked;
  try {
    assert.throws(() => assertPrivateOutput(process.cwd(), join(linked, 'out')));
    assert.throws(() => assertPrivateCorpus(linked));
  } finally {
    if (original === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = original;
  }
});

it('allows fixed extra commits for dependencies referenced by external plan files', () => {
  const item = { ...sample.cases[0], dependencyCommits: ['a'.repeat(40)] };
  assert.deepEqual(parseManifest({ ...sample, cases: [item] }).cases[0].dependencyCommits, ['a'.repeat(40)]);
  assert.throws(() => parseManifest({ ...sample, cases: [{ ...item, dependencyCommits: ['main'] }] }));
});

it('does not trust an inherited dependency-bin git when checking privacy', async () => {
  const { chmodSync, mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { delimiter, join } = await import('node:path');
  const temp = mkdtempSync(join(tmpdir(), 'bench-privacy-git-')),
    repo = join(temp, 'repo'),
    bin = join(temp, 'node_modules', '.bin');
  mkdirSync(repo);
  mkdirSync(bin, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const fake = join(bin, process.platform === 'win32' ? 'git.cmd' : 'git');
  writeFileSync(
    fake,
    process.platform === 'win32'
      ? '@echo off\r\necho fatal: not a git repository 1>&2\r\nexit /b 128\r\n'
      : '#!/bin/sh\necho "fatal: not a git repository" >&2\nexit 128\n',
  );
  chmodSync(fake, 0o700);
  const before = process.env.PATH;
  process.env.PATH = [bin, before].join(delimiter);
  try {
    assert.throws(
      () => assertPrivateOutput(process.cwd(), join(repo, 'output')),
      /private benchmark data must be outside Git repositories/,
    );
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
});
