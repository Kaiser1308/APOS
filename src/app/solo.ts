import { randomUUID } from 'node:crypto';
import type { GoalEventType } from '../domain/transitions.js';
import type { PhaseCheckpoint } from '../domain/contracts.js';
import type { SqliteStore } from '../store/sqlite.js';
import type { RuntimeAdapter, RuntimeRef } from '../runtime/orca.js';

export class SoloService {
  constructor(private readonly store: SqliteStore, private readonly runtime: RuntimeAdapter) {}

  private record(goalId: string, type: GoalEventType, data?: unknown): void {
    this.store.append({ id: randomUUID(), goalId, type, data, at: new Date().toISOString() });
  }

  async start(goalId: string, repoPath: string): Promise<RuntimeRef> {
    const state = this.store.getGoal(goalId);
    if (!state || !state.proposal || !state.proposal.mode.startsWith('solo')) throw new Error('Approved Solo proposal required');
    if (state.status === 'executing' && state.runtimeRef) return state.runtimeRef as RuntimeRef;
    if (state.status !== 'ready') throw new Error('Goal is not ready to dispatch');
    const key = state.dispatchIntent ?? randomUUID();
    if (state.dispatchIntent) {
      const recovered = await this.runtime.recover?.(key);
      if (!recovered) throw new Error('Dispatch outcome unknown; reconcile Orca before retrying');
      this.record(goalId, 'execution-started', recovered);
      return recovered;
    }
    this.record(goalId, 'dispatch-intended', key);
    const ref = await this.runtime.startSolo({ repoPath, goalId, proposalVersion: state.proposal.version, idempotencyKey: key });
    this.record(goalId, 'execution-started', ref);
    return ref;
  }

  async resume(goalId: string): Promise<RuntimeRef> {
    const state = this.store.getGoal(goalId);
    if (!state || state.status !== 'executing' || state.proposal?.mode !== 'solo-phased' || !state.runtimeRef || !state.checkpoint) throw new Error('Phased checkpoint and active owner required');
    const observation = await this.runtime.inspect(state.runtimeRef as RuntimeRef);
    if (observation.state !== 'settled') throw new Error('Prior Orca dispatch must be settled before phased resume');
    const next = await this.runtime.resumeSolo(state.runtimeRef as RuntimeRef, state.checkpoint as PhaseCheckpoint);
    this.record(goalId, 'runtime-resumed', next);
    return next;
  }

  async reconcile(goalId: string): Promise<'live' | 'settled' | 'unverifiable'> {
    const state = this.store.getGoal(goalId);
    if (!state?.runtimeRef) return 'unverifiable';
    const observation = await this.runtime.inspect(state.runtimeRef as RuntimeRef);
    return observation.state;
  }
}
