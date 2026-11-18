import { isSketchGoal, type GoalSpec } from './contracts.js';
import type { GoalState, GoalStatus } from './transitions.js';

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

  for (const state of relevant) {
    for (const req of state.spec.requirements ?? []) {
      const existing = reqMap.get(req.id);
      if (existing) {
        existing.entries.push({ goal: state, req });
      } else {
        reqMap.set(req.id, {
          id: req.id,
          text: req.text,
          sourcePath: state.spec.source?.path ?? '',
          sourceSha256: state.spec.source?.sha256 ?? '',
          entries: [{ goal: state, req }],
        });
      }
    }
  }

  // Also check if another Goal in `goals` (even with a newer source snapshot) accepted a requirement id
  for (const state of goals) {
    for (const req of state.spec.requirements ?? []) {
      const existing = reqMap.get(req.id);
      if (existing && !existing.entries.some(e => e.goal.spec.id === state.spec.id)) {
        existing.entries.push({ goal: state, req });
      }
    }
  }

  const requirements: PlanRequirementRow[] = [];
  const placeholderTargets = new Set<string>();

  for (const item of reqMap.values()) {
    const closedAccepting = item.entries.find(e => e.req.disposition === 'acceptance' && e.goal.status === 'closed');
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

    const activeAccepting = item.entries.find(
      e => e.req.disposition === 'acceptance' && e.goal.status !== 'closed' && e.goal.status !== 'stopped',
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

    const latest = item.entries.at(-1)!;
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

    const deferredEntry = [...item.entries]
      .reverse()
      .find(e => e.req.disposition === 'excluded' && e.req.exclusion?.kind === 'deferred');
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
      if (target.status === 'closed' || target.status === 'stopped') {
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
