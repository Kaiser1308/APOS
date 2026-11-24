import { execFileSync } from 'node:child_process';
import { LAYER_IDS } from '../domain/layers.js';
import { entryMatches, removalOf, removalProblems } from '../domain/removal.js';
import { testKey } from '../domain/test-lock.js';
import type { GoalState } from '../domain/transitions.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';
import { pinnedSetupOf, runnerFor } from './test-lock-wiring.js';

/**
 * What `goal approve` finds out about the tests a Goal declares removed, run on the repo as it is (the commit the plan will
 * start from): why it cannot be approved, and the list of tests that would go, for the Human to read before confirming.
 */
export function removalApproval(
  ctx: CliContext,
  journal: ProjectJournal,
  state: GoalState,
  setupVersion: number | undefined,
): { problems: string[]; lines: string[] } {
  const declared = removalOf(state.spec);
  if (!declared.length) return { problems: [], lines: [] };
  const setup = pinnedSetupOf(ctx, journal, setupVersion);
  if (!setup)
    return {
      problems: [
        `${state.spec.id} removes tests, which are named through the layers of the setup: approve a setup first (\`apos setup draft\`, probe, approve)`,
      ],
      lines: [],
    };
  const commit = execFileSync('git', ['-C', ctx.repo(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const runner = runnerFor(ctx, journal, state.spec.id, 'removal');
  const ran: Record<string, string[]> = {};
  const problems: string[] = [];
  for (const layer of new Set(declared.map(item => item.entry.slice(0, item.entry.indexOf('::'))))) {
    const [part, id] = layer.split('.');
    const where = setup.parts[part ?? ''];
    const tools =
      LAYER_IDS.find(item => item === id) && where ? where.layers[id as keyof typeof where.layers] : undefined;
    if (!where || !tools?.length) continue;
    const got = runner.layerTests(commit, part!, where.root, id as (typeof LAYER_IDS)[number], tools);
    if (got.problems.length)
      problems.push(`${layer} did not run on ${commit.slice(0, 12)}: ${got.problems.join('; ')}`);
    else ran[layer] = got.tests.map(test => testKey(part!, id!, test.id));
  }
  problems.push(...removalProblems(state.spec, ran));
  // One block per criterion: the tests its entries match on the repo as it is, each once.
  const lines = [...new Set(declared.map(item => item.acceptanceId))].flatMap(acceptanceId => {
    const entries = declared.filter(item => item.acceptanceId === acceptanceId).map(item => item.entry);
    const hits = Object.values(ran)
      .flat()
      .filter(key => entries.some(entry => entryMatches(entry, key)));
    return [`  ${acceptanceId}: ${hits.length} test(s)`, ...hits.map(key => `    - ${key}`)];
  });
  return { problems, lines };
}
