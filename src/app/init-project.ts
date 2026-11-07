import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  for (const role of ['pm', 'lead', 'worker']) {
    const source = join(packageRoot, 'skills', role, 'SKILL.md');
    const targetDir = join(repo, '.claude', 'skills', `apos-${role}`);
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, 'SKILL.md');
    if (!existsSync(target)) copyFileSync(source, target);
  }
}
