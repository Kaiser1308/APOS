import { randomUUID } from 'node:crypto';
import type { GoalRepository } from '../store/journal.js';
import type { GoalState } from '../domain/transitions.js';

export class GoalRegistryService {
  constructor(private readonly store: GoalRepository) {}

  private assertAcyclic(): void {
    const byId = new Map(this.store.listGoals().map(item => [item.spec.id, item]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Goal dependency cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of byId.get(id)?.spec.dependencies ?? []) if (byId.has(dep)) walk(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of byId.keys()) walk(id);
  }

  /** `currentSourceDigest` reads the committed snapshot; approval refuses a snapshot that differs from the spec. */
  approve(goalId: string, currentSourceDigest?: (goalId: string) => string | undefined): void {
    this.assertAcyclic();
    const state = this.store.getGoal(goalId);
    if (currentSourceDigest && state && currentSourceDigest(goalId) !== state.spec.source.sha256) throw new Error(`Source snapshot for ${goalId} is missing or differs from the Goal sha256`);
    this.store.append({ id: randomUUID(), goalId, type: 'goal-approved', at: new Date().toISOString() });
  }

  recommend(): GoalState | undefined {
    return this.store.listGoals().filter(state => state.status === 'approved' && state.spec.dependencies.every(id => this.store.getGoal(id)?.status === 'closed')).sort((a, b) => a.spec.priority - b.spec.priority)[0];
  }

  select(goalId: string): void {
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'approved') throw new Error('Approved Goal required');
    const pending = state.spec.dependencies.filter(id => this.store.getGoal(id)?.status !== 'closed');
    if (pending.length) throw new Error(`Goal dependencies not closed: ${pending.join(', ')}`);
    this.store.append({ id: randomUUID(), goalId, type: 'goal-selected', at: new Date().toISOString() });
  }
}
