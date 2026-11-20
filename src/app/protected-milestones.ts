import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { protectedChanges } from '../domain/gate.js';
import type { GoalRepository } from '../ports/goal-repository.js';

/** Only exact controller-published blobs, including their Git mode, can cross the protected-file guard. */
export function untrustedProtectedFiles(
  store: Pick<GoalRepository, 'getGoal'>,
  goalId: string,
  repo: string,
  head: string,
  changed: string[],
): string[] {
  const milestones = store.getGoal(goalId)?.publishedDocuments ?? [];
  return protectedChanges(goalId, changed).filter(path => {
    const milestone = [...milestones].reverse().find(item => item.files[path]);
    if (!milestone) return true;
    try {
      const blob = execFileSync('git', ['-C', repo, 'show', `${head}:${path}`]);
      const hash = createHash('sha256').update(blob).digest('hex');
      const mode = (commit: string) =>
        execFileSync('git', ['-C', repo, 'ls-tree', commit, '--', path], { encoding: 'utf8' }).split(' ')[0];
      return hash !== milestone.files[path] || mode(head) !== mode(milestone.commit);
    } catch {
      return true;
    }
  });
}
