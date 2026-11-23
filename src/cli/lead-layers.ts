import { layerChoiceProblems } from '../domain/layer-plan.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { GoalState } from '../domain/transitions.js';

/** Why the layers a Lead added in its plan cannot run: no setup to take them from, or a layer the setup lacks. */
export function planLayerProblems(state: GoalState, setup: ProjectSetup | undefined): string[] {
  const proposal = state.proposal;
  if (!proposal) return [];
  const wanted =
    proposal.mode === 'multi-wp'
      ? Object.values(state.packages ?? {}).map(item => ({
          id: item.spec.id,
          layers: item.spec.layers,
          paths: item.spec.paths,
        }))
      : [{ id: 'WP-MAIN', layers: proposal.layers, paths: proposal.paths }];
  if (!setup)
    return wanted
      .filter(item => Object.keys(item.layers ?? {}).length)
      .map(
        item =>
          `${item.id} adds layers, but ${state.spec.id} is not pinned to a setup: there is nothing for them to run`,
      );
  return wanted.flatMap(item => layerChoiceProblems({ setup, ...item }));
}
