import { globToRegExp } from './glob.js';
import { LAYER_IDS, type LayerId } from './layers.js';
import type { LayerSpec, ProjectSetup } from './project-setup.js';

export type Stage = 'submit' | 'integrate' | 'close';
export const STAGES: readonly Stage[] = ['submit', 'integrate', 'close'];

/** Spec 6.2. L6 is a manual check of the Goal, not a tool, so no floor lists it. */
export const DEFAULT_FLOOR: Record<Stage, LayerId[]> = {
  submit: ['L0', 'L1', 'L2'],
  integrate: ['L1', 'L2', 'L3'],
  close: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
};

/**
 * Why a layer runs: the setup's floor, a layer the Lead added to the package, a trigger that fired on a changed file
 * or on a Goal flag, or a criterion of the Goal that names the tool (`benchmark`, `scan`).
 */
export type LayerWhy = 'floor' | 'lead' | 'trigger' | 'goal-flag' | 'proof';
export type LayerRun = {
  /** A part name, or `system` for the layers that span parts. */
  part: string;
  layer: LayerId;
  tool: LayerSpec;
  why: LayerWhy;
  /** The floor says run this and an approved exception says not to: the plan keeps it so the table can show it. The gate does not run it. */
  reduced?: boolean;
};

export type PlanInput = {
  setup: ProjectSetup;
  stage: Stage;
  /** Files changed from the base: at `submit` they pick the parts; a trigger's globs match them at every stage. */
  changed: string[];
  /** The layers the Lead added for this package, by stage. */
  packageLayers?: Partial<Record<Stage, LayerId[]>>;
  /** Flags the Human approved with the Goal. */
  goalFlags: string[];
  reductions: { stage: Stage; layer: LayerId }[];
  /** Tools (`<part>.<layer>.<id>`) that criteria of the Goal depend on: they run at `close`. */
  requiredTools?: string[];
};

const SYSTEM = 'system';
const under = (file: string, root: string): boolean => root === '.' || file === root || file.startsWith(`${root}/`);
const normal = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//, '');

const toolsOf = (setup: ProjectSetup, part: string, layer: LayerId): LayerSpec[] =>
  (part === SYSTEM ? setup.system?.[layer] : setup.parts[part]?.layers[layer]) ?? [];
const flagged = (tool: LayerSpec, flags: string[]): boolean =>
  !tool.when || tool.when === 'always' || flags.includes(tool.when.slice('flag:'.length));

/**
 * What the gate runs at one stage, and why. A pure function of the pinned setup, the package, the Goal and the
 * change: the same input always gives the same plan, and the plan is recorded with the gate.
 * Each (part, layer, tool) appears once however many reasons name it. A reduction cancels only the floor's reason:
 * a trigger, a Lead's choice or a criterion that also names the layer keeps it running.
 */
export function planLayers(input: PlanInput): LayerRun[] {
  const { setup, stage, goalFlags } = input;
  const changed = input.changed.map(normal);
  const floor = setup.floor?.[stage] ?? DEFAULT_FLOOR[stage];
  const parts = Object.keys(setup.parts);
  const scope =
    stage === 'submit' ? parts.filter(name => changed.some(file => under(file, setup.parts[name]!.root))) : parts;
  const reducedLayers = new Set(input.reductions.filter(item => item.stage === stage).map(item => item.layer));

  type Entry = { part: string; layer: LayerId; tool: LayerSpec; origins: Set<LayerWhy>; first: LayerWhy };
  const entries = new Map<string, Entry>();
  const add = (part: string, layer: LayerId, tool: LayerSpec, why: LayerWhy) => {
    const key = `${part}.${layer}.${tool.id}`;
    const entry = entries.get(key);
    if (entry) entry.origins.add(why);
    else entries.set(key, { part, layer, tool, origins: new Set([why]), first: why });
  };
  const addLayer = (part: string, layer: LayerId, why: LayerWhy) => {
    for (const tool of toolsOf(setup, part, layer)) if (flagged(tool, goalFlags)) add(part, layer, tool, why);
  };

  for (const layer of floor) {
    for (const part of scope) addLayer(part, layer, 'floor');
    if (stage !== 'submit') addLayer(SYSTEM, layer, 'floor');
  }
  for (const layer of input.packageLayers?.[stage] ?? []) {
    for (const part of scope) addLayer(part, layer, 'lead');
    addLayer(SYSTEM, layer, 'lead');
  }
  for (const trigger of setup.triggers ?? []) {
    if (trigger.at !== stage) continue;
    const byFile = trigger.when.changed?.some(glob => changed.some(file => globToRegExp(normal(glob)).test(file)));
    const byFlag = trigger.when.goalFlag !== undefined && goalFlags.includes(trigger.when.goalFlag);
    if (!byFile && !byFlag) continue;
    for (const target of trigger.run) {
      const [part, layer] = target.split('.') as [string, LayerId];
      addLayer(part, layer, byFile ? 'trigger' : 'goal-flag');
    }
  }
  if (stage === 'close')
    for (const key of input.requiredTools ?? []) {
      const [part, layer, ...rest] = key.split('.');
      const tool = toolsOf(setup, part ?? '', layer as LayerId).find(item => item.id === rest.join('.'));
      if (tool) add(part!, layer as LayerId, tool, 'proof');
    }

  const order = (entry: Entry) => LAYER_IDS.indexOf(entry.layer);
  return [...entries.values()]
    .sort((a, b) => order(a) - order(b))
    .map(entry => {
      const reduced = entry.origins.size === 1 && entry.origins.has('floor') && reducedLayers.has(entry.layer);
      return {
        part: entry.part,
        layer: entry.layer,
        tool: entry.tool,
        why: entry.first,
        ...(reduced ? { reduced: true } : {}),
      };
    });
}
