import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGitRoot } from '../store/project-history.js';
import { ShellExecutor, type CommandExecutor } from './shell-executor.js';

export interface Workspace {
  readonly path: string;
  /** What was done so the checks can find their dependencies; written into every check log. */
  readonly preparation?: string;
  dispose(): void;
}
export interface WorkspaceFactory {
  checkout(repoPath: string, commit: string): Workspace;
}

export type WorktreeOptions = {
  /** Runs `npm ci` when the main checkout's node_modules cannot be reused. */
  executor?: CommandExecutor;
  installTimeoutMs?: number;
};

const INSTALL_COMMAND = 'npm ci --no-audit --no-fund';
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;

type Preparation = { note?: string; link?: string };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

/**
 * Seen live (GOAL-G3, WP-SIGNALS): CHK-2 `npm run check` went red with "prettier is not recognized"
 * because a fresh worktree has no node_modules. When the gate commit's lock file is identical to the
 * main checkout's, that checkout's node_modules is linked in; otherwise `npm ci` runs, so a real
 * dependency change is installed and tested instead of hidden behind the old tree.
 */
export function prepareDependencies(
  repo: string,
  path: string,
  executor: CommandExecutor,
  timeoutMs: number,
): Preparation {
  if (!existsSync(join(path, 'package.json'))) return {};
  const lockPath = join(path, 'package-lock.json');
  if (!existsSync(lockPath))
    return { note: '# dependencies: package.json without package-lock.json; nothing prepared' };
  const link = join(path, 'node_modules');
  if (existsSync(link)) return { note: '# dependencies: node_modules is committed at this commit; left as is' };
  const mainModules = join(repo, 'node_modules');
  const mainLock = join(repo, 'package-lock.json');
  let reason: string;
  if (!isDirectory(mainModules)) reason = 'main checkout has no node_modules';
  else if (!existsSync(mainLock) || !sameText(readFileSync(mainLock, 'utf8'), readFileSync(lockPath, 'utf8')))
    reason = 'package-lock.json differs from the main checkout';
  else {
    const target = realpathSync(mainModules);
    try {
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      return {
        link,
        note: `# dependencies: linked node_modules from ${target} (package-lock.json identical to the main checkout)`,
      };
    } catch (error) {
      reason = `linking ${target} failed: ${(error as Error).message}`;
    }
  }
  const started = Date.now();
  const result = executor.run(INSTALL_COMMAND, path, {}, timeoutMs);
  const seconds = Math.round((Date.now() - started) / 1000);
  const status = `exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`;
  return {
    note: `# dependencies: ${INSTALL_COMMAND} (${reason}) ${status} in ${seconds}s\n${result.output.trimEnd()}\n# end of dependency install`,
  };
}

/** Removes only the link itself; a real directory is never touched, so the linked target survives. */
export function removeLink(link: string): void {
  let stats;
  try {
    stats = lstatSync(link);
  } catch {
    return;
  }
  if (!stats.isSymbolicLink()) return;
  try {
    unlinkSync(link);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EISDIR') throw error;
    rmdirSync(link);
  }
}

/** A fresh detached Git worktree at exactly the requested commit, outside the managed repo. */
export class GitWorktreeFactory implements WorkspaceFactory {
  private readonly executor: CommandExecutor;
  private readonly installTimeoutMs: number;

  constructor(options: WorktreeOptions = {}) {
    this.executor = options.executor ?? new ShellExecutor();
    this.installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  }

  checkout(repoPath: string, commit: string): Workspace {
    const repo = assertGitRoot(repoPath);
    const full = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', `${commit}^{commit}`], {
      encoding: 'utf8',
    }).trim();
    const path = mkdtempSync(join(tmpdir(), 'apos-gate-'));
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '--force', path, full], { stdio: 'ignore' });
    const head = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    let link: string | undefined;
    const dispose = () => {
      // Never let git or rmSync walk into a linked node_modules: drop the link before removing the tree.
      if (link) removeLink(link);
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', path], { stdio: 'ignore' });
      } catch {
        rmSync(path, { recursive: true, force: true });
        execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' });
      }
    };
    if (head !== full) {
      dispose();
      throw new Error(`Gate workspace is at ${head}, expected ${full}`);
    }
    try {
      const prepared = prepareDependencies(repo, path, this.executor, this.installTimeoutMs);
      link = prepared.link;
      return { path, preparation: prepared.note, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }
}
