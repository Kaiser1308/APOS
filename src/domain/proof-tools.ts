import type { GoalSpec } from './contracts.js';
import type { LayerId } from './layers.js';
import type { ProjectSetup, LayerSpec } from './project-setup.js';
import type { Threshold } from './threshold.js';

export type FailOn = 'error' | 'warning' | 'note';
const RANK: Record<FailOn, number> = { note: 0, warning: 1, error: 2 };
/** The stricter of two blocking levels: `note` blocks the most. */
export const stricter = (a: FailOn, b: FailOn): FailOn => (RANK[a] <= RANK[b] ? a : b);

/** What the Goal's non-functional criteria ask of one tool. The Human approved these numbers with the Goal. */
export type ProofDemand = {
  /** `<part>.<layer>.<id>`. */
  tool: string;
  /** `benchmark`: one measurement per metric name, each with the thresholds every criterion on it gives. */
  metrics: { name: string; thresholds: Threshold[]; criteria: string[] }[];
  /** `scan`: the strictest blocking level any criterion names. */
  failOn?: FailOn;
  /** Criteria ids, for the table. */
  criteria: string[];
};

export function proofDemands(goal: GoalSpec): ProofDemand[] {
  const byTool = new Map<string, ProofDemand>();
  const demand = (tool: string): ProofDemand => {
    let item = byTool.get(tool);
    if (!item) byTool.set(tool, (item = { tool, metrics: [], criteria: [] }));
    return item;
  };
  for (const criterion of goal.acceptance) {
    if (criterion.benchmark) {
      const item = demand(criterion.benchmark.tool);
      item.criteria.push(criterion.id);
      const threshold = { op: criterion.benchmark.op, value: criterion.benchmark.value };
      const metric = item.metrics.find(entry => entry.name === criterion.benchmark!.metric);
      if (metric) {
        metric.thresholds.push(threshold);
        metric.criteria.push(criterion.id);
      } else item.metrics.push({ name: criterion.benchmark.metric, thresholds: [threshold], criteria: [criterion.id] });
    }
    if (criterion.scan) {
      const item = demand(criterion.scan.tool);
      item.criteria.push(criterion.id);
      item.failOn = item.failOn ? stricter(item.failOn, criterion.scan.failOn) : criterion.scan.failOn;
    }
  }
  return [...byTool.values()];
}

/** The setup's tool a `<part>.<layer>.<id>` reference names, or undefined when the setup has none. */
export function findTool(
  setup: ProjectSetup,
  ref: string,
): { part: string; layer: LayerId; tool: LayerSpec } | undefined {
  const [part, layer, ...rest] = ref.split('.');
  if (!part || !layer) return undefined;
  const tools = part === 'system' ? setup.system?.[layer as LayerId] : setup.parts[part]?.layers[layer as LayerId];
  const tool = tools?.find(item => item.id === rest.join('.'));
  return tool ? { part, layer: layer as LayerId, tool } : undefined;
}

/** Why the Goal's non-functional criteria cannot be proved with this setup: a tool it does not have, or one of the wrong kind. */
export function proofToolProblems(goal: GoalSpec, setup: ProjectSetup): string[] {
  const problems: string[] = [];
  for (const criterion of goal.acceptance) {
    for (const [kind, ref, format] of [
      ['benchmark', criterion.benchmark?.tool, 'metric'],
      ['scan', criterion.scan?.tool, 'sarif'],
    ] as const) {
      if (ref === undefined) continue;
      const found = findTool(setup, ref);
      if (!found) problems.push(`${criterion.id} ${kind}: the tool ${ref} is not in the pinned setup`);
      else if (found.tool.format !== format)
        problems.push(`${criterion.id} ${kind}: ${ref} reports ${found.tool.format}, a ${kind} needs a ${format} tool`);
    }
  }
  return problems;
}
