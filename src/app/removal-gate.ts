import type { TestSet } from '../domain/assurance.js';
import { LAYER_IDS, type LayerId } from '../domain/layers.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { RemovedTest } from '../domain/removal.js';
import { lockedTestKeys, type TestLock } from '../domain/test-lock.js';
import type { GoalState } from '../domain/transitions.js';

export type Wanted = Map<string, { part: string; layer: LayerId }>;
export type TestRun = (setup: ProjectSetup, wanted: Wanted, commit: string) => { set: TestSet; problems: string[] };

/** The layers a gate runs to take the inventory: L1 of every part, the layers the lock's tests live in, and where declared tests are. */
export function inventoryLayers(setup: ProjectSetup, lock: TestLock | undefined, removable: RemovedTest[]): Wanted {
  const wanted: Wanted = new Map();
  for (const [part, where] of Object.entries(setup.parts))
    if (where.layers.L1?.length) wanted.set(`${part}.L1`, { part, layer: 'L1' });
  for (const entry of lock?.map ?? [])
    wanted.set(`${entry.part}.${entry.layer}`, { part: entry.part, layer: entry.layer });
  // A declared test is looked for in its own layer: one outside the floor would otherwise never be seen to be gone.
  for (const { entry } of removable) {
    const [part, layer] = entry.slice(0, entry.indexOf('::')).split('.');
    const id = LAYER_IDS.find(item => item === layer);
    if (part && id && setup.parts[part]?.layers[id]?.length) wanted.set(`${part}.${id}`, { part, layer: id });
  }
  return wanted;
}

/** Who locked a test, among the other Goals of the project: the Goal id, or undefined when none did. */
export function lockedByOthers(goals: GoalState[] | undefined, own: string): (key: string) => string | undefined {
  const locks = (goals ?? [])
    .filter(state => state.spec.id !== own && state.testLock)
    .map(state => ({ goalId: state.spec.id, keys: new Set(lockedTestKeys(state.testLock!)) }))
    .sort((a, b) => a.goalId.localeCompare(b.goalId));
  return key => locks.find(item => item.keys.has(key))?.goalId;
}
