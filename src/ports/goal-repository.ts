import type { GoalEvent, GoalState } from '../domain/transitions.js';

export interface GoalRepository {
  append(event: GoalEvent): void;
  getGoal(id: string): GoalState | undefined;
  listGoals(): GoalState[];
  events(id: string): GoalEvent[];
  /** sha256 of the controller's source snapshot for the Goal's current version, when the store keeps one. */
  currentSourceDigest?(goalId: string): string | undefined;
  /** Controller-side directory for gate logs and other artifacts owners must not touch. */
  artifactRoot?(): string;
}
