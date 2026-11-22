import { parseWorkPackage, type WorkPackageSpec } from '../domain/packages.js';
import { newEvent } from './events.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { GoalRepository } from '../ports/goal-repository.js';

/** The Lead's plan edits: which packages a Goal has. Delivery of a package goes through `submit`. */
export class PackageService {
  constructor(private readonly store: GoalRepository) {}

  private record(goalId: string, type: GoalEventType, data: unknown): void {
    this.store.append(newEvent(goalId, type, data));
  }

  add(goalId: string, value: unknown, reason?: string): WorkPackageSpec {
    const spec = parseWorkPackage(value);
    const state = this.store.getGoal(goalId);
    const drafting = state?.status === 'planned' && reason === undefined;
    this.record(goalId, drafting ? 'package-added' : 'package-plan-added', drafting ? spec : { spec, reason });
    return spec;
  }

  remove(goalId: string, packageId: string, reason: string): void {
    this.record(goalId, 'package-removed', { packageId, reason });
  }

  revise(goalId: string, value: unknown, reason: string): WorkPackageSpec {
    const spec = parseWorkPackage(value);
    this.record(goalId, 'package-revised', { spec, reason });
    return spec;
  }
}
