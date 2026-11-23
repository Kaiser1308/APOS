import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { protectedChanges } from '../domain/gate.js';
import { testMapPath } from '../domain/test-lock.js';
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
  const lock = store.getGoal(goalId)?.testLock;
  return protectedChanges(goalId, changed).filter(path => {
    // The tester's map is committed by the tester, not APOS; it is trusted while it is the blob that was locked.
    if (lock && path === testMapPath(goalId)) {
      try {
        const same = (commit: string) =>
          execFileSync('git', ['-C', repo, 'rev-parse', `${commit}:${path}`], { encoding: 'utf8' });
        return same(head) !== same(lock.commit);
      } catch {
        return true;
      }
    }
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
