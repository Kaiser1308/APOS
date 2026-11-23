import { lockedTestKeys } from '../domain/test-lock.js';
import type { GoalState } from '../domain/transitions.js';

/** What `goal show` and `tests show` say about a Goal's locked tests; the first line always answers "is there a lock". */
export function lockSummary(state: GoalState): string[] {
  const lock = state.testLock;
  if (!lock) {
    if (state.status === 'testing') return ['chưa có khoá test: đang chờ tester nộp (apos tests submit)'];
    return [
      state.setupVersion === undefined
        ? 'không có khoá test (Goal không ghim setup)'
        : 'không có khoá test (setup không khai tests.paths, hoặc Goal không có tiêu chí cần test)',
    ];
  }
  const asserts = Object.values(lock.asserts).reduce((sum, count) => sum + count, 0);
  const lines = [
    `khoá test: commit ${lock.commit}${lock.revisionOf ? ` (sửa từ ${lock.revisionOf})` : ''}, ${lockedTestKeys(lock).length} test, ${Object.keys(lock.files).length} file, ${asserts} assert (đếm dòng, chỉ gần đúng)`,
  ];
  if (state.pendingRevision)
    lines.push(`bản sửa chờ duyệt: ${state.pendingRevision.commit} (${state.pendingRevision.reason})`);
  return lines;
}
