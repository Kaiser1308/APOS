import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertGitRoot } from '../store/project-history.js';

export async function initProject(repoPath: string): Promise<void> {
  const repo = assertGitRoot(repoPath);
  const dir = join(repo, '.apos');
  mkdirSync(join(dir, 'goals'), { recursive: true });
  const config = join(dir, 'project.yaml');
  if (!existsSync(config)) writeFileSync(config, 'schemaVersion: 1\n', 'utf8');
}
