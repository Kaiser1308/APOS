import { orphanRequirements } from '../domain/plan.js';
import type { GoalState } from '../domain/transitions.js';
import type { GoalRepository } from '../ports/goal-repository.js';

export type InboxKind = 'needs-decision' | 'awaiting-outcome' | 'notice';
export type InboxItem = { goalId: string; kind: InboxKind; detail: string; at?: string };

type ManualCheckNotice = { deliveryCommit?: string; checks?: string[] };

const manualCheckResolved = (state: GoalState, notice: ManualCheckNotice): boolean =>
  (notice.checks ?? []).every(checkId =>
    (state.manualConfirmations ?? []).some(
      item => item.checkId === checkId && item.deliveryCommit === notice.deliveryCommit,
    ),
  );

/**
 * What needs the Human, in the order `apos inbox` prints it. The CLI and the UI both read this, so the
 * two cannot disagree about which Goals are waiting.
 */
export function buildInbox(repo: GoalRepository): InboxItem[] {
  const items: InboxItem[] = [];
  const goals = repo.listGoals();
  for (const state of goals) {
    const goalId = state.spec.id;
    const events = repo.events(goalId);
    const lastOf = (type: string) => [...events].reverse().find(item => item.type === type)?.at;
    if (state.status === 'blocked')
      items.push({
        goalId,
        kind: 'needs-decision',
        detail: JSON.stringify(state.blocker),
        at: lastOf('blocked') ?? events.at(-1)?.at,
      });
    if (state.status === 'verified')
      items.push({
        goalId,
        kind: 'awaiting-outcome',
        detail: `gate ${state.gate?.result} on ${state.gate?.deliveryCommit}`,
        at: lastOf('verified') ?? events.at(-1)?.at,
      });
    // A notice about a closed or stopped Goal is history, and the supervisor's `awaiting-outcome` notice repeats the verified status item above.
    if (state.status === 'closed' || state.status === 'stopped') continue;
    const answered = new Set(
      events
        .filter(item => item.type === 'decision-logged')
        .map(item => (item.data as { answers?: string } | null)?.answers)
        .filter(Boolean),
    );
    const handedOff = new Set(
      events
        .filter(item => item.type === 'owner-handed-off')
        .map(item => (item.data as { from?: string } | null)?.from)
        .filter((id): id is string => Boolean(id)),
    );
    for (const notice of events.filter(item => item.type === 'human-notified')) {
      const data = notice.data as { kind?: unknown; messageId?: string; dispatchId?: string } | null;
      // A Lead question the Human has already answered is history.
      if (data?.kind === 'lead-question' && data.messageId && answered.has(data.messageId)) continue;
      if (
        typeof data?.dispatchId === 'string' &&
        ['owner-idle', 'lead-idle', 'agent-exhausted', 'stalled'].includes(String(data.kind ?? '')) &&
        (handedOff.has(data.dispatchId) || Boolean(state.settlements?.[data.dispatchId]))
      )
        continue;
      if (state.status === 'verified' && (notice.data as { kind?: unknown } | null)?.kind === 'awaiting-outcome')
        continue;
      // A manual-check notice is a question about one commit: it ends once every check it lists is confirmed there.
      if (data?.kind === 'manual-check' && manualCheckResolved(state, notice.data as ManualCheckNotice)) continue;
      if (data?.kind === 'orphan-requirement') continue;
      items.push({ goalId, kind: 'notice', detail: JSON.stringify(notice.data), at: notice.at });
    }
  }
  for (const orphan of orphanRequirements(goals)) {
    const events = repo.events(orphan.targetGoalId);
    const closedAt = [...events]
      .reverse()
      .find(item => item.type === 'outcome-accepted' || item.type === 'outcome-stopped')?.at;
    items.push({
      goalId: orphan.targetGoalId,
      kind: 'notice',
      detail: JSON.stringify({
        kind: 'orphan-requirement',
        goalId: orphan.targetGoalId,
        fromGoalId: orphan.fromGoalId,
        requirementId: orphan.id,
        note: `Requirement ${orphan.id} (${orphan.text}) was deferred from ${orphan.fromGoalId} to ${orphan.targetGoalId}, which closed without accepting it. ${orphan.fromGoalId} and ${orphan.targetGoalId} are closed, so the way out is a new Goal that adopts ${orphan.id} (reuse the same requirement id) or excludes it there with an exclusion.`,
      }),
      at: closedAt ?? events.at(-1)?.at,
    });
  }
  return items;
}
