import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeFactory, removeLink } from './gate-workspace.js';
import type { CommandExecutor, ExecResult } from './shell-executor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

class RecordingExecutor implements CommandExecutor {
  readonly shell = 'test-shell';
  readonly calls: { command: string; cwd: string; timeoutMs: number }[] = [];
  constructor(private readonly result: ExecResult = { exitCode: 0, timedOut: false, output: 'added 0 packages' }) {}
  run(command: string, cwd: string, _env: Record<string, string>, timeoutMs: number): ExecResult {
    this.calls.push({ command, cwd, timeoutMs });
    return this.result;
  }
}

const lock = (name: string) =>
  `${JSON.stringify({ name, lockfileVersion: 3, requires: true, packages: {} }, null, 2)}\n`;

/** A repo whose main checkout has an installed (gitignored) node_modules with a sentinel file. */
function repo(files: Record<string, string>, installed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'apos-ws-repo-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'base');
  if (installed) {
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'sentinel.txt'), 'installed');
  }
  const commit = (changes: Record<string, string>) => {
    for (const [name, content] of Object.entries(changes)) writeFileSync(join(dir, name), content);
    git('add', '-A');
    git('-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'change');
    return git('rev-parse', 'HEAD');
  };
  return { dir, head: git('rev-parse', 'HEAD'), commit };
}

const packageJson = JSON.stringify({ name: 'scratch', version: '1.0.0', scripts: { check: 'node check.js' } });

describe('gate worktree dependencies', () => {
  it('links the main checkout node_modules when the lock file is identical, and removing the worktree keeps the target', () => {
    const { dir, head } = repo({ 'package.json': packageJson, 'package-lock.json': lock('scratch') });
    const executor = new RecordingExecutor();
    const workspace = new GitWorktreeFactory({ executor }).checkout(dir, head);
    const link = join(workspace.path, 'node_modules');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, 'dep', 'sentinel.txt'), 'utf8')).toBe('installed');
    expect(workspace.preparation).toMatch(/^# dependencies: linked node_modules from .*package-lock.json identical/);
    expect(executor.calls).toEqual([]);
    workspace.dispose();
    expect(existsSync(workspace.path)).toBe(false);
    expect(readFileSync(join(dir, 'node_modules', 'dep', 'sentinel.txt'), 'utf8')).toBe('installed');
  });

  it('runs npm ci in the worktree and records it when the gate commit changes the lock file', () => {
    const { dir, commit } = repo({ 'package.json': packageJson, 'package-lock.json': lock('scratch') });
    const delivery = commit({ 'package-lock.json': lock('scratch-with-new-dep') });
    writeFileSync(join(dir, 'package-lock.json'), lock('scratch'));
    const executor = new RecordingExecutor({ exitCode: 1, timedOut: false, output: 'npm ERR! lock mismatch' });
    const workspace = new GitWorktreeFactory({ executor, installTimeoutMs: 1234 }).checkout(dir, delivery);
    try {
      expect(executor.calls).toEqual([
        { command: 'npm ci --no-audit --no-fund', cwd: workspace.path, timeoutMs: 1234 },
      ]);
      expect(existsSync(join(workspace.path, 'node_modules'))).toBe(false);
      expect(workspace.preparation).toMatch(
        /# dependencies: npm ci --no-audit --no-fund \(package-lock.json differs from the main checkout\) exit 1 in \d+s\nnpm ERR! lock mismatch/,
      );
    } finally {
      workspace.dispose();
    }
  });

  it('runs npm ci when the main checkout has no node_modules', () => {
    const { dir, head } = repo({ 'package.json': packageJson, 'package-lock.json': lock('scratch') }, false);
    const executor = new RecordingExecutor();
    const workspace = new GitWorktreeFactory({ executor }).checkout(dir, head);
    workspace.dispose();
    expect(executor.calls).toHaveLength(1);
    expect(workspace.preparation).toMatch(/\(main checkout has no node_modules\) exit 0/);
  });

  it('runs npm ci instead of linking when the lock has workspace links, which would resolve into the main checkout (PR #37 review)', () => {
    const workspaceLock = `${JSON.stringify({
      name: 'scratch',
      lockfileVersion: 3,
      packages: {
        '': { name: 'scratch', workspaces: ['packages/*'] },
        'node_modules/local-lib': { resolved: 'packages/local-lib', link: true },
        'packages/local-lib': { version: '1.0.0' },
      },
    })}\n`;
    const { dir, head } = repo({ 'package.json': packageJson, 'package-lock.json': workspaceLock });
    const executor = new RecordingExecutor();
    const workspace = new GitWorktreeFactory({ executor }).checkout(dir, head);
    try {
      expect(existsSync(join(workspace.path, 'node_modules'))).toBe(false);
      expect(executor.calls).toHaveLength(1);
      expect(workspace.preparation).toMatch(/\(package-lock.json has workspace or file: links into the checkout\)/);
    } finally {
      workspace.dispose();
    }
    expect(readFileSync(join(dir, 'node_modules', 'dep', 'sentinel.txt'), 'utf8')).toBe('installed');
  });

  it('runs npm ci instead of linking when a root install script may generate into node_modules (PR #37 review)', () => {
    const generating = JSON.stringify({ name: 'scratch', version: '1.0.0', scripts: { postinstall: 'node gen.js' } });
    const { dir, head } = repo({ 'package.json': generating, 'package-lock.json': lock('scratch') });
    const executor = new RecordingExecutor();
    const workspace = new GitWorktreeFactory({ executor }).checkout(dir, head);
    try {
      expect(existsSync(join(workspace.path, 'node_modules'))).toBe(false);
      expect(executor.calls).toHaveLength(1);
      expect(workspace.preparation).toMatch(/\(package.json has a root install script/);
    } finally {
      workspace.dispose();
    }
  });

  it('changes nothing for a project without package.json', () => {
    const { dir, head } = repo({ 'main.py': 'print(1)\n' });
    const executor = new RecordingExecutor();
    const workspace = new GitWorktreeFactory({ executor }).checkout(dir, head);
    expect(existsSync(join(workspace.path, 'node_modules'))).toBe(false);
    expect(workspace.preparation).toBeUndefined();
    expect(executor.calls).toEqual([]);
    workspace.dispose();
  });

  it('removes only a link, never a real directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'apos-ws-link-'));
    dirs.push(root);
    const real = join(root, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'keep.txt'), 'x');
    removeLink(real);
    expect(existsSync(join(real, 'keep.txt'))).toBe(true);
    removeLink(join(root, 'missing'));
  });
});
