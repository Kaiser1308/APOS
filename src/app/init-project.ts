import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertGitRoot } from '../store/project-history.js';

export async function initProject(repoPath: string): Promise<void> {
  const repo = assertGitRoot(repoPath);
  const dir = join(repo, '.apos');
  mkdirSync(join(dir, 'goals'), { recursive: true });
  const config = join(dir, 'project.yaml');
  if (!existsSync(config)) writeFileSync(config, 'schemaVersion: 1\n', 'utf8');
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, 'state.sqlite*\n', 'utf8');
  const files = [config, ignore];
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  for (const role of ['pm', 'lead', 'worker', 'reviewer']) {
    const source = join(packageRoot, 'skills', role, 'SKILL.md');
    const targetDir = join(repo, '.claude', 'skills', `apos-${role}`);
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, 'SKILL.md');
    if (!existsSync(target)) { copyFileSync(source, target); files.push(target); }
  }
  const paths = files.map(path => relative(repo, path));
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', ...paths], { encoding: 'utf8' });
  if (status.trim()) {
    execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', 'add', '--', ...paths]);
    execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', '-c', 'user.name=APOS', '-c', 'user.email=apos@local.invalid', 'commit', '--only', '-m', 'apos: initialize managed project', '--', ...paths]);
  }
}
