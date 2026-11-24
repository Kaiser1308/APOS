import { planLayers } from '../domain/layer-plan.js';
import type { HotfixLayerResult } from '../domain/hotfix.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import { notRunnable, type ToolRunner } from './layer-runner.js';

/**
 * L0 and L1 of every part the hotfix touched, run on the hotfix commit and only recorded: the Human has already let the
 * commit through, so nothing here holds anything up. A red result is for the inbox to say, an unrunnable tool is
 * `unverifiable`, never green. A setup without an L0 or L1 tool simply has none to run.
 */
export function runHotfixLayers(input: {
  runner: ToolRunner;
  setup: ProjectSetup;
  commit: string;
  changed: string[];
}): HotfixLayerResult[] {
  const { runner, setup, commit } = input;
  const runs = planLayers({
    setup: { ...setup, floor: { ...setup.floor, submit: ['L0', 'L1'] } },
    stage: 'submit',
    changed: input.changed,
    goalFlags: [],
    reductions: [],
  }).filter(run => run.layer === 'L0' || run.layer === 'L1');
  return runs.map(run => {
    const base = { part: run.part, layer: run.layer as 'L0' | 'L1', tool: run.tool.id };
    const root = setup.parts[run.part]?.root ?? '.';
    const { exec, report } = runner.run(commit, run.tool, run.tool.command, root);
    const unrunnable = notRunnable(exec);
    if (unrunnable) return { ...base, status: 'unverifiable' as const, note: unrunnable };
    const failing =
      report?.kind === 'tests' ? report.tests.filter(t => t.status === 'fail' || t.status === 'error') : [];
    if (failing.length) return { ...base, status: 'fail' as const, note: `${failing.length} test(s) failing` };
    if (exec.exitCode !== 0) return { ...base, status: 'fail' as const, note: `exit ${exec.exitCode}` };
    return { ...base, status: 'pass' as const };
  });
}
