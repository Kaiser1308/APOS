import { execFileSync } from 'node:child_process';
import {
  existsSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { assertGitRoot } from '../store/project-history.js';
import { UserError } from '../domain/errors.js';
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

type Preparation = { note?: string };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

function externalTo(root: string, target: string): boolean {
  const within = relative(root, target);
  return isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`);
}

/** Reject links in committed dependencies that could let commands mutate an external tree. */
function assertIsolatedDependencies(root: string, path = root): void {
  for (const name of readdirSync(path)) {
    const entry = join(path, name);
    const info = lstatSync(entry);
    if (info.isSymbolicLink()) {
      if (externalTo(root, realpathSync(entry)))
        throw new UserError(`Dependency link points outside node_modules: ${entry}`);
    } else if (info.isDirectory()) assertIsolatedDependencies(root, entry);
  }
}

/** Rebase internal links into the copy; an external or cyclic link forces a fresh install. */
function copyDependencies(
  source: string,
  destination: string,
  sourceRoot: string,
  destinationRoot: string,
  ancestors = new Set<string>(),
): void {
  const original = lstatSync(source);
  const info = statSync(source);
  if (original.isSymbolicLink()) {
    const real = realpathSync(source);
    const within = relative(sourceRoot, real);
    if (externalTo(sourceRoot, real)) throw new Error(`Dependency link points outside node_modules: ${source}`);
    if (info.isDirectory() && ancestors.has(real)) throw new Error(`Cyclic dependency link: ${source}`);
    const mapped = join(destinationRoot, within);
    const target = process.platform === 'win32' && info.isDirectory() ? mapped : relative(dirname(destination), mapped);
    symlinkSync(target, destination, info.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    return;
  }
  if (info.isFile()) {
    copyFileSync(source, destination, constants.COPYFILE_FICLONE);
    return;
  }
  if (!info.isDirectory()) throw new Error(`Unsupported dependency entry: ${source}`);
  const real = realpathSync(source);
  if (ancestors.has(real)) throw new Error(`Cyclic dependency link: ${source}`);
  const next = new Set(ancestors).add(real);
  mkdirSync(destination);
  for (const name of readdirSync(source))
    copyDependencies(join(source, name), join(destination, name), sourceRoot, destinationRoot, next);
}

/**
 * Workspace packages and `file:` directory deps are installed as links into the checkout that ran
 * npm, so the main checkout's node_modules would run its own copy of them instead of the gate commit's
 * (reported on PR #37). Any such link, or a lock that cannot be read, means a fresh install.
 */
function hasLocalLinks(lockText: string): boolean {
  let lock: unknown;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return true;
  }
  if (typeof lock !== 'object' || lock === null) return true;
  const { packages, dependencies } = lock as { packages?: unknown; dependencies?: unknown };
  const entries = (value: unknown) => (typeof value === 'object' && value !== null ? Object.values(value) : []);
  const linked = (entry: unknown) =>
    typeof entry === 'object' &&
    entry !== null &&
    ((entry as { link?: unknown }).link === true ||
      String((entry as { version?: unknown }).version ?? '').startsWith('file:'));
  return entries(packages).some(linked) || entries(dependencies).some(linked);
}

const ROOT_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/**
 * A root install script can generate files into node_modules from checkout sources, so the main
 * checkout's tree may hold its own generated code (reported on PR #37). Unreadable means a fresh install.
 */
function hasRootInstallScript(packageJsonPath: string): boolean {
  if (!existsSync(packageJsonPath)) return false;
  try {
    const { scripts } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: unknown };
    return typeof scripts === 'object' && scripts !== null && ROOT_INSTALL_SCRIPTS.some(name => name in scripts);
  } catch {
    return true;
  }
}

/**
 * Seen live (GOAL-G3, WP-SIGNALS): CHK-2 `npm run check` went red with "prettier is not recognized"
 * because a fresh worktree has no node_modules. When the gate commit's lock file is identical to the
 * main checkout's, an isolated copy of that checkout's node_modules is used; otherwise `npm ci` runs, so a real
 * dependency change is installed and tested instead of hidden behind the old tree.
 */
export function prepareDependencies(
  repo: string,
  path: string,
  executor: CommandExecutor,
  timeoutMs: number,
): Preparation {
  const targetModules = join(path, 'node_modules');
  let committedDirectory = false;
  try {
    if (lstatSync(targetModules).isSymbolicLink()) removeLink(targetModules);
    else committedDirectory = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (committedDirectory && isDirectory(targetModules)) assertIsolatedDependencies(realpathSync(targetModules));
  if (!existsSync(join(path, 'package.json'))) return {};
  const lockPath = join(path, 'package-lock.json');
  if (!existsSync(lockPath))
    return { note: '# dependencies: package.json without package-lock.json; nothing prepared' };
  if (committedDirectory) return { note: '# dependencies: node_modules is committed at this commit; left as is' };
  const mainModules = join(repo, 'node_modules');
  const mainLock = join(repo, 'package-lock.json');
  let reason: string;
  if (!isDirectory(mainModules)) reason = 'main checkout has no node_modules';
  else if (!existsSync(mainLock) || !sameText(readFileSync(mainLock, 'utf8'), readFileSync(lockPath, 'utf8')))
    reason = 'package-lock.json differs from the main checkout';
  else if (hasLocalLinks(readFileSync(lockPath, 'utf8')))
    reason = 'package-lock.json has workspace or file: links into the checkout';
  else if (hasRootInstallScript(join(path, 'package.json')) || hasRootInstallScript(join(repo, 'package.json')))
    reason = 'package.json has a root install script that may generate into node_modules';
  else {
    try {
      const sourceRoot = realpathSync(mainModules);
      copyDependencies(sourceRoot, targetModules, sourceRoot, targetModules);
      return {
        note: '# dependencies: copied node_modules from the main checkout (package-lock.json identical)',
      };
    } catch (error) {
      rmSync(targetModules, { recursive: true, force: true });
      reason = `copying node_modules failed: ${(error as Error).message}`;
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
    const dispose = () => {
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', path], { stdio: 'ignore' });
      } catch {
        /* finished below */
      }
      // Seen on Windows after `npm ci` with workspaces: git exits 0 but leaves the workspace junctions behind.
      if (existsSync(path)) {
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
      return { path, preparation: prepared.note, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }
}
