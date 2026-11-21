import { spawnSync } from 'node:child_process';

export type ExecResult = { exitCode: number | null; timedOut: boolean; output: string };
export interface CommandExecutor {
  readonly shell: string;
  run(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): ExecResult;
}

const TIMEOUT_MARK = '[apos] check timed out; process tree killed';
/**
 * Runs the command in a child node process that owns the timeout. Killing only the shell would leave
 * grandchildren alive holding the workspace (seen on Windows), so the launcher kills the whole tree.
 */
const LAUNCHER = `
const { spawn, spawnSync } = require('child_process');
const command = process.argv[1], ms = Number(process.argv[2]), win = process.platform === 'win32';
const child = spawn(command, { shell: true, stdio: 'inherit', detached: !win, windowsHide: true });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (win) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}, ms);
child.on('exit', code => {
  clearTimeout(timer);
  if (timedOut) { process.stderr.write(${JSON.stringify(`\n${TIMEOUT_MARK}\n`)}); process.exit(124); }
  process.exit(code === null ? 1 : code);
});
`;

/** Runs through the platform's default shell; the shell is recorded so base and delivery provably match. */
export class ShellExecutor implements CommandExecutor {
  readonly shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  run(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): ExecResult {
    const result = spawnSync(process.execPath, ['-e', LAUNCHER, command, String(timeoutMs)], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: timeoutMs + 30_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const timedOut =
      (result.status === 124 && output.includes(TIMEOUT_MARK)) ||
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return {
      exitCode: timedOut ? null : result.status,
      timedOut,
      output: `${output}${result.error && !timedOut ? `\n[apos] ${result.error.message}` : ''}`,
    };
  }
}
