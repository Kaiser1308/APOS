import { newEvent } from './events.js';
import type { GoalRepository } from '../ports/goal-repository.js';

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
  /** The Human approves the Goal together with its appetite, which only the controller keeps. */
  approve(
    goalId: string,
    appetite: unknown,
    currentSourceDigest: ((goalId: string) => string | undefined) | undefined = this.store.currentSourceDigest?.bind(
      this.store,
    ),
    confirmation?: unknown,
  ): void {
    this.assertAcyclic();
    const state = this.store.getGoal(goalId);
    if (currentSourceDigest && state && currentSourceDigest(goalId) !== state.spec.source.sha256)
      throw new Error(`Source snapshot for ${goalId} is missing or differs from the Goal sha256`);
    this.store.append(newEvent(goalId, 'goal-approved', { appetite, confirmation }));
  }

  select(goalId: string, confirmation?: unknown): void {
    const state = this.store.getGoal(goalId);
    if (!state) throw new Error(`Goal does not exist: ${goalId}`);
    if (state.status !== 'approved')
      throw new Error(
        `Approved Goal required: ${goalId} is ${state.status}${state.status === 'draft' ? ' (gate A first: apos goal approve)' : ''}`,
      );
    const pending = state.spec.dependencies.filter(id => this.store.getGoal(id)?.status !== 'closed');
    if (pending.length) throw new Error(`Goal dependencies not closed: ${pending.join(', ')}`);
    this.store.append(newEvent(goalId, 'goal-selected', confirmation ? { confirmation } : undefined));
  }
}
