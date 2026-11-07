import type { GoalRepository } from '../store/journal.js';

export type GoalMetrics = {
  goalId: string;
  status: string;
  mode?: string;
  packageCount: number;
  attempts: number;
  blockers: number;
  reviewChanges: number;
  cycleTimeMs?: number;
};

export class MetricsService {
  constructor(private readonly store: GoalRepository) {}

  show(goalId: string): GoalMetrics {
    const state = this.store.getGoal(goalId);
    if (!state) throw new Error(`Unknown Goal: ${goalId}`);
    const events = this.store.events(goalId);
    const created = events.find(item => item.type === 'goal-drafted');
    const closed = [...events].reverse().find(item => item.type === 'outcome-accepted');
    const packages = Object.values(state.packages ?? {});
    return {
      goalId, status: state.status, mode: state.proposal?.mode,
      packageCount: packages.length,
      attempts: (state.soloAttempts ?? 0) + packages.reduce((sum, item) => sum + item.attempts, 0),
      blockers: events.filter(item => ['blocked', 'package-blocked', 'package-retry-exhausted'].includes(item.type)).length,
      reviewChanges: events.filter(item => item.type === 'review-submitted' && (item.data as { result?: string })?.result === 'changes').length,
      ...(created && closed ? { cycleTimeMs: Date.parse(closed.at) - Date.parse(created.at) } : {})
    };
  }
}
