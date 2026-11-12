import type { GoalRepository } from '../store/journal.js';

export type InboxKind = 'needs-decision' | 'awaiting-outcome' | 'notice';
export type InboxItem = { goalId: string; kind: InboxKind; detail: string; at?: string };

/**
 * What needs the Human, in the order `apos inbox` prints it. The CLI and the UI both read this, so the
 * two cannot disagree about which Goals are waiting.
 */
export function buildInbox(repo: GoalRepository): InboxItem[] {
  const items: InboxItem[] = [];
  for (const state of repo.listGoals()) {
    const goalId = state.spec.id;
    const events = repo.events(goalId);
    const lastOf = (type: string) => [...events].reverse().find(item => item.type === type)?.at;
    if (state.status === 'blocked') items.push({ goalId, kind: 'needs-decision', detail: JSON.stringify(state.blocker), at: lastOf('blocked') ?? events.at(-1)?.at });
    if (state.status === 'verified') items.push({ goalId, kind: 'awaiting-outcome', detail: `gate ${state.gate?.result} on ${state.gate?.deliveryCommit}`, at: lastOf('verified') ?? events.at(-1)?.at });
    // A notice about a closed or stopped Goal is history, and the supervisor's `awaiting-outcome` notice repeats the verified status item above.
    if (state.status === 'closed' || state.status === 'stopped') continue;
    for (const notice of events.filter(item => item.type === 'human-notified')) {
      if (state.status === 'verified' && (notice.data as { kind?: unknown } | null)?.kind === 'awaiting-outcome') continue;
      items.push({ goalId, kind: 'notice', detail: JSON.stringify(notice.data), at: notice.at });
    }
  }
  return items;
}
