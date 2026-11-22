import type { GoalRepository } from '../ports/goal-repository.js';

export type GoalMetrics = {
  goalId: string;
  status: string;
  /** How many times each package was submitted. */
  submitsByPackage: Record<string, number>;
  /** Gate runs that came back red, across all packages. */
  redGates: number;
  /** Minutes from `goal select` to `verified`; to now while the Goal is still on the clock. */
  minutes?: number;
};

export class MetricsService {
  constructor(
    private readonly store: GoalRepository,
    private readonly now: () => number = Date.now,
  ) {}

  show(goalId: string): GoalMetrics {
    const state = this.store.getGoal(goalId);
    if (!state) throw new Error(`Unknown Goal: ${goalId}`);
    const events = this.store.events(goalId);
    const submitsByPackage: Record<string, number> = {};
    let redGates = 0;
    for (const event of events) {
      const data = event.data as { packageId?: string; report?: { result?: string } } | undefined;
      if (event.type === 'package-submitted' && data?.packageId)
        submitsByPackage[data.packageId] = (submitsByPackage[data.packageId] ?? 0) + 1;
      if (event.type === 'package-gate-recorded' && data?.report?.result === 'red') redGates += 1;
    }
    const selected = events.find(item => item.type === 'goal-selected');
    const verified = events.find(item => item.type === 'verified');
    const end = verified
      ? Date.parse(verified.at)
      : ['selected', 'planned', 'executing', 'blocked'].includes(state.status)
        ? this.now()
        : undefined;
    return {
      goalId,
      status: state.status,
      submitsByPackage,
      redGates,
      ...(selected && end !== undefined
        ? { minutes: Math.max(0, Math.round((end - Date.parse(selected.at)) / 60_000)) }
        : {}),
    };
  }
}
