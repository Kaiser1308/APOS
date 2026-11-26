import { isSketchGoal, type GoalSpec } from './contracts.js';
import { effectiveStatus, type GoalState, type GoalStatus } from './transitions.js';

export type RequirementCoverageStatus = 'covered' | 'planned' | 'deferred' | 'orphan' | 'out-of-scope' | 'unplanned';

export type PlanGoalRow = {
  id: string;
  outcome: string;
  status: GoalStatus | 'deferred';
  sketch: boolean;
  priority: number;
};

export type PlanRequirementRow = {
  id: string;
  text: string;
  sourcePath: string;
  sourceSha256: string;
  status: RequirementCoverageStatus;
  goalId?: string;
  fromGoalId?: string;
  reason?: string;
};

export type PlanSummary = {
  goals: PlanGoalRow[];
  requirements: PlanRequirementRow[];
};

export type OrphanRequirement = {
  id: string;
  text: string;
  fromGoalId: string;
  targetGoalId: string;
};

type ReqEntry = { goal: GoalState; req: GoalSpec['requirements'][number] };

const deferTarget = (entry: ReqEntry): string | undefined =>
  entry.req.disposition === 'excluded' && entry.req.exclusion?.kind === 'deferred' ? entry.req.exclusion.to : undefined;

/**
 * Goals come back in ID order, not chronology, so the last entry means nothing. Follow the deferral chain
 * instead: start at an entry no other entry defers to, and walk deferrals to the Goal that holds the final
 * word (an out-of-scope exclusion there wins over the deferral that led to it). Cycles stop at the first repeat.
 */
function resolveDisposition(entries: ReqEntry[]): { end: ReqEntry; lastDefer?: ReqEntry } {
  const targets = new Set<string>();
  for (const e of entries) {
    const to = deferTarget(e);
    if (to && to !== e.goal.spec.id) targets.add(to);
  }
  const heads = entries.filter(e => !targets.has(e.goal.spec.id));
  let current = (heads.length ? heads : entries).at(-1)!;
  let lastDefer: ReqEntry | undefined;
  const seen = new Set<string>();
  while (!seen.has(current.goal.spec.id)) {
    seen.add(current.goal.spec.id);
    const to = deferTarget(current);
    if (!to) break;
    lastDefer = current;
    const next = entries.find(e => e.goal.spec.id === to);
    if (!next) break;
    current = next;
  }
  return { end: current, lastDefer };
}

export function buildPlan(goals: GoalState[], sourceSha256?: string): PlanSummary {
  const byId = new Map<string, GoalState>(goals.map(item => [item.spec.id, item]));
  const relevant = sourceSha256 ? goals.filter(item => item.spec.source?.sha256 === sourceSha256) : goals;
  const reqMap = new Map<
    string,
    {
      id: string;
      text: string;
      sourcePath: string;
      sourceSha256: string;
      entries: { goal: GoalState; req: GoalSpec['requirements'][number] }[];
    }
  >();

  const keyOf = (state: GoalState, id: string): string => `${state.spec.source?.sha256 ?? ''}|${id}`;

  for (const state of relevant) {
    for (const req of state.spec.requirements ?? []) {
      const key = keyOf(state, req.id);
      const existing = reqMap.get(key);
      if (existing) {
        existing.entries.push({ goal: state, req });
      } else {
        reqMap.set(key, {
          id: req.id,
          text: req.text,
          sourcePath: state.spec.source?.path ?? '',
          sourceSha256: state.spec.source?.sha256 ?? '',
          entries: [{ goal: state, req }],
        });
      }
    }
  }

  // Another Goal of the SAME source may accept/defer a requirement id; other sources never mix.
  for (const state of goals) {
    for (const req of state.spec.requirements ?? []) {
      const existing = reqMap.get(keyOf(state, req.id));
      if (existing && !existing.entries.some(e => e.goal.spec.id === state.spec.id)) {
        existing.entries.push({ goal: state, req });
      }
    }
  }

  // An explicit reference connects a new brief to an earlier requirement. IDs alone
  // remain scoped to their source; references to missing sources never match by ID.
  const allEntries = goals.flatMap(goal => (goal.spec.requirements ?? []).map(req => ({ goal, req })));
  const descendants = (root: string): ReqEntry[] => {
    const seen = new Set([root]);
    const queue = [root];
    const result: ReqEntry[] = [];
    while (queue.length) {
      const parent = queue.shift()!;
      for (const entry of allEntries) {
        const ref = entry.req.adopts;
        if (!ref || `${ref.sourceSha256}|${ref.requirementId}` !== parent) continue;
        const child = keyOf(entry.goal, entry.req.id);
        if (seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
        result.push(...allEntries.filter(e => keyOf(e.goal, e.req.id) === child));
      }
    }
    return result;
  };

  const requirements: PlanRequirementRow[] = [];
  const placeholderTargets = new Set<string>();

  for (const [key, item] of reqMap) {
    const adopted = descendants(key);
    const entries = [...item.entries, ...adopted];
    const closedAccepting = entries.find(
      e => e.req.disposition === 'acceptance' && effectiveStatus(e.goal) === 'closed',
    );
    if (closedAccepting) {
      requirements.push({
        id: item.id,
        text: item.text,
        sourcePath: item.sourcePath,
        sourceSha256: item.sourceSha256,
        status: 'covered',
        goalId: closedAccepting.goal.spec.id,
      });
      continue;
    }

    const activeAccepting = entries.find(
      e =>
        e.req.disposition === 'acceptance' &&
        effectiveStatus(e.goal) !== 'closed' &&
        effectiveStatus(e.goal) !== 'stopped',
    );
    if (activeAccepting) {
      requirements.push({
        id: item.id,
        text: item.text,
        sourcePath: item.sourcePath,
        sourceSha256: item.sourceSha256,
        status: 'planned',
        goalId: activeAccepting.goal.spec.id,
      });
      continue;
    }

    // The adopting brief carries the latest disposition; follow its own
    // deferral chain within that source just as for legacy requirements.
    const lastAdoption = adopted.at(-1);
    const dispositionEntries = lastAdoption
      ? adopted.filter(e => keyOf(e.goal, e.req.id) === keyOf(lastAdoption.goal, lastAdoption.req.id))
      : item.entries;
    const { end: latest, lastDefer } = resolveDisposition(dispositionEntries);
    if (latest.req.disposition === 'excluded' && latest.req.exclusion?.kind === 'out-of-scope') {
      requirements.push({
        id: item.id,
        text: item.text,
        sourcePath: item.sourcePath,
        sourceSha256: item.sourceSha256,
        status: 'out-of-scope',
        goalId: latest.goal.spec.id,
        reason: latest.req.exclusionReason,
      });
      continue;
    }

    const deferredEntry = lastDefer;
    if (deferredEntry && deferredEntry.req.exclusion?.kind === 'deferred') {
      const targetId = deferredEntry.req.exclusion.to;
      const target = byId.get(targetId);
      if (!target) {
        placeholderTargets.add(targetId);
        requirements.push({
          id: item.id,
          text: item.text,
          sourcePath: item.sourcePath,
          sourceSha256: item.sourceSha256,
          status: 'deferred',
          goalId: targetId,
          fromGoalId: deferredEntry.goal.spec.id,
          reason: deferredEntry.req.exclusionReason,
        });
        continue;
      }
      if (['closed', 'stopped'].includes(effectiveStatus(target))) {
        requirements.push({
          id: item.id,
          text: item.text,
          sourcePath: item.sourcePath,
          sourceSha256: item.sourceSha256,
          status: 'orphan',
          goalId: targetId,
          fromGoalId: deferredEntry.goal.spec.id,
          reason: deferredEntry.req.exclusionReason,
        });
        continue;
      }
      requirements.push({
        id: item.id,
        text: item.text,
        sourcePath: item.sourcePath,
        sourceSha256: item.sourceSha256,
        status: 'deferred',
        goalId: targetId,
        fromGoalId: deferredEntry.goal.spec.id,
        reason: deferredEntry.req.exclusionReason,
      });
      continue;
    }

    if (latest.req.disposition === 'excluded' && !latest.req.exclusion) {
      requirements.push({
        id: item.id,
        text: item.text,
        sourcePath: item.sourcePath,
        sourceSha256: item.sourceSha256,
        status: 'unplanned',
        goalId: latest.goal.spec.id,
        reason: latest.req.exclusionReason,
      });
      continue;
    }

    requirements.push({
      id: item.id,
      text: item.text,
      sourcePath: item.sourcePath,
      sourceSha256: item.sourceSha256,
      status: 'orphan',
      goalId: latest.goal.spec.id,
    });
  }

  const goalRows: PlanGoalRow[] = [...relevant]
    .sort((a, b) => (a.spec.priority ?? 1) - (b.spec.priority ?? 1) || a.spec.id.localeCompare(b.spec.id))
    .map(state => ({
      id: state.spec.id,
      outcome: state.spec.outcome ?? '',
      status: state.status,
      sketch: Boolean(state.spec.acceptance && isSketchGoal(state.spec)),
      priority: state.spec.priority ?? 1,
    }));

  for (const targetId of [...placeholderTargets].sort()) {
    goalRows.push({
      id: targetId,
      outcome: '(deferred target — not created yet)',
      status: 'deferred',
      sketch: true,
      priority: 999,
    });
  }

  return { goals: goalRows, requirements };
}

export function orphanRequirements(goals: GoalState[]): OrphanRequirement[] {
  const plan = buildPlan(goals);
  return plan.requirements
    .filter(item => item.status === 'orphan' && item.fromGoalId && item.goalId)
    .map(item => ({
      id: item.id,
      text: item.text,
      fromGoalId: item.fromGoalId!,
      targetGoalId: item.goalId!,
    }));
}
