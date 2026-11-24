import { hotfixRows, redNote, short, unprovenCount, unprovenLine } from '../domain/hotfix.js';
import { hasException } from '../domain/exceptions.js';
import { orphanRequirements } from '../domain/plan.js';
import { effectiveStatus, type GoalState } from '../domain/transitions.js';
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
export function buildInbox(repo: GoalRepository, now: string = new Date().toISOString()): InboxItem[] {
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
    // An archived (legacy) Goal is read-only: its old notices are history, not work.
    if (['closed', 'stopped', 'legacy'].includes(effectiveStatus(state)) || state.status === 'legacy') continue;
    // A Goal on a setup approved with no baseline is low assurance until it closes: the Human sees it where they look.
    if (state.baselineMissing?.length)
      items.push({
        goalId,
        kind: 'notice',
        detail: JSON.stringify({
          kind: 'low-assurance',
          layers: state.baselineMissing,
          note: `BẢO ĐẢM THẤP: repo chưa có test nền (${state.baselineMissing.join(', ')})`,
        }),
        at: events.at(-1)?.at,
      });
    const warnings = [
      ...new Set(
        [state.gate, ...Object.values(state.packages ?? {}).map(item => item.gate)].flatMap(
          gate => gate?.warnings ?? [],
        ),
      ),
    ];
    if (warnings.length)
      items.push({
        goalId,
        kind: 'notice',
        detail: JSON.stringify({ kind: 'attention', warnings }),
        at: events.at(-1)?.at,
      });
    for (const [packageId, item] of Object.entries(state.packages ?? {})) {
      if (item.status !== 'needs-human' || !item.gate) continue;
      const commit = item.gate.deliveryCommit;
      const reasons = item.gate.checks
        .filter(check => check.status !== 'pass')
        .map(check =>
          check.status === 'manual-pending'
            ? (state.manualConfirmations ?? []).some(c => c.checkId === check.checkId && c.deliveryCommit === commit)
              ? `manual check ${check.checkId} is confirmed on ${commit}: submit again`
              : `manual check ${check.checkId} awaits confirmation on ${commit} (apos gate confirm), then submit again`
            : check.status === 'needs-human'
              ? (() => {
                  const kind = check.checkId === 'APOS-INFRA' ? 'tests-infra' : 'needs-human';
                  const approval = (state.exceptions ?? []).find(
                    entry => entry.kind === kind && entry.ref === packageId && entry.commit === commit,
                  );
                  return approval
                    ? `${check.reason}, duyệt bởi ${approval.by}: submit again with the same commit`
                    : `${check.checkId} needs-human: ${check.reason}. Approve with: apos exception approve ${goalId} --kind ${kind} --ref ${packageId} --reason <why> (--by agent:<name> | --human)`;
                })()
              : `${check.checkId} ${check.status}: ${check.reason}`,
        );
      items.push({
        goalId,
        kind: 'needs-decision',
        detail: JSON.stringify({ why: 'package-needs-human', packageId, reasons }),
        at: item.gate.at,
      });
    }
    if (
      state.pendingRevision &&
      !hasException(state, 'tests-weakened', state.pendingRevision.commit, state.pendingRevision.commit)
    )
      items.push({
        goalId,
        kind: 'needs-decision',
        detail: JSON.stringify({
          why: 'tests-revision-pending',
          commit: state.pendingRevision.commit,
          reason: state.pendingRevision.reason,
          problems: state.pendingRevision.problems,
          approve: `apos exception approve ${goalId} --kind tests-weakened --ref ${state.pendingRevision.commit} --reason <why> (--by agent:<name> | --human)`,
        }),
        at: lastOf('tests-revision-pending') ?? events.at(-1)?.at,
      });
    const answered = new Set(
      events
        .filter(item => item.type === 'decision-logged')
        .map(item => (item.data as { answers?: string } | null)?.answers)
        .filter(Boolean),
    );
    for (const notice of events.filter(item => item.type === 'human-notified')) {
      const data = notice.data as { kind?: unknown; messageId?: string } | null;
      // A Lead question the Human has already answered is history.
      if (data?.kind === 'lead-question' && data.messageId && answered.has(data.messageId)) continue;
      if (state.status === 'verified' && (notice.data as { kind?: unknown } | null)?.kind === 'awaiting-outcome')
        continue;
      // A manual-check notice is a question about one commit: it ends once every check it lists is confirmed there.
      if (data?.kind === 'manual-check' && manualCheckResolved(state, notice.data as ManualCheckNotice)) continue;
      if (data?.kind === 'orphan-requirement') continue;
      items.push({ goalId, kind: 'notice', detail: JSON.stringify(notice.data), at: notice.at });
    }
  }
  items.push(...hotfixItems(goals, now));
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

/**
 * What the Human owes to hotfixes they let through: a red line for one past its deadline, an ordinary one while it waits,
 * and one project-wide count of those without evidence (a stopped Goal still counts). The lines name the absolute
 * deadline, never "3h ago", so the same item reads the same on every call.
 */
function hotfixItems(goals: GoalState[], now: string): InboxItem[] {
  const rows = hotfixRows(goals, now);
  const items: InboxItem[] = [];
  for (const { goal, hotfix, status } of rows) {
    const red = redNote(hotfix);
    const named = `hotfix ${short(hotfix.commit)}`;
    if (status === 'overdue')
      items.push({
        goalId: goal.spec.id,
        kind: 'needs-decision',
        detail: JSON.stringify({
          why: 'hotfix-overdue',
          note: `${named} quá hạn ${hotfix.dueAt}, chưa có bằng chứng${red ? `; ${red}` : ''}`,
        }),
        at: hotfix.dueAt,
      });
    if (status === 'waiting')
      items.push({
        goalId: goal.spec.id,
        kind: 'notice',
        detail: JSON.stringify({
          kind: 'hotfix-waiting',
          note: `${named} đang chờ bằng chứng, hạn ${hotfix.dueAt}${red ? `; ${red}` : ''}`,
        }),
        at: hotfix.acceptedAt,
      });
  }
  const count = unprovenCount(rows);
  if (count)
    items.push({
      goalId: 'PROJECT',
      kind: 'notice',
      detail: JSON.stringify({ kind: 'hotfix-unproven', count, note: unprovenLine(count) }),
    });
  return items;
}
