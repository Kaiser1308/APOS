import { INVENTORY_CHECK } from './assurance.js';
import { entryMatches } from './removal.js';
import { testKey } from './test-lock.js';
import type { GoalState } from './transitions.js';

/** What the table says about one `removed` criterion, read from the log. */
export type RemovalEvidence = {
  acceptanceId: string;
  /** How many tests the criterion declares (entries of `removesTests`). */
  declared: number;
  /** The test of absence the lock holds for it, as `<part>.<layer>::<id>`. */
  tests: string[];
  /** Present once a green gate has judged the delivery: the lock commit the test was red on, the delivery it is green on. */
  proven?: { redOn: string; greenOn: string; removed: number; locked: { goalId: string; count: number }[] };
};

/** One entry per `removed` criterion, or undefined for a Goal that removes nothing. */
export function removalEvidence(state: GoalState): RemovalEvidence[] | undefined {
  const criteria = state.spec.acceptance.filter(item => item.proof === 'removed');
  if (!criteria.length) return undefined;
  const gate = state.gate?.result === 'green' ? state.gate : undefined;
  const removal = gate?.checks.find(check => check.checkId === INVENTORY_CHECK)?.removal;
  return criteria.map(item => {
    const entries = item.removesTests ?? [];
    const mine = (key: string) => entries.some(entry => entryMatches(entry, key));
    const tests = (state.testLock?.map ?? [])
      .filter(entry => entry.acceptanceId === item.id)
      .flatMap(entry => entry.testIds.map(id => testKey(entry.part, entry.layer, id)));
    return {
      acceptanceId: item.id,
      declared: entries.length,
      tests,
      ...(gate && removal && state.testLock
        ? {
            proven: {
              redOn: state.testLock.commit.slice(0, 7),
              greenOn: gate.deliveryCommit.slice(0, 7),
              removed: removal.tests.filter(mine).length,
              locked: removal.locked
                .map(item => ({ goalId: item.goalId, count: item.tests.filter(mine).length }))
                .filter(item => item.count),
            },
          }
        : {}),
    };
  });
}

/** The lines of the table for a Goal that removes a feature; `label` pads the left column. */
export function removalLines(evidence: RemovalEvidence[], label: (text: string) => string): string[] {
  return evidence.map(item => {
    if (!item.proven)
      return `${label('Xoá tính năng')}${item.acceptanceId}: chưa chứng minh (khai xoá ${item.declared} mục; chưa có gate xanh trên bản giao)`;
    const { proven } = item;
    const locked = proven.locked.map(entry => `${entry.count} test đã khoá của ${entry.goalId}`).join(', ');
    return `${label('Xoá tính năng')}${item.acceptanceId}: test ${item.tests.join(', ')} đỏ trên ${proven.redOn}, xanh trên ${proven.greenOn}; xoá đúng ${proven.removed} test đã khai${locked ? ` (${locked})` : ''}`;
  });
}
