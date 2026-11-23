import { describe, expect, it } from 'vitest';
import type { GoalSpec } from '../domain/contracts.js';
import type { LayerSpec } from '../domain/project-setup.js';
import type { Finding } from '../domain/results/index.js';
import type { ToolRunner } from './layer-runner.js';
import { maintenanceScan, scanTwice } from './maintenance-gate.js';

const finding = (ruleId: string, level: Finding['level'] = 'error'): Finding => ({
  ruleId,
  level,
  fingerprint: `fp:${ruleId}`,
});
const tool = (command: string): LayerSpec => ({ id: 'scan', command, format: 'sarif' });
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);

/** A scanner by commit: what it reports there, one list per run; the commits it was asked about, in order. */
function scanner(byCommit: Record<string, Finding[][]>): Pick<ToolRunner, 'run'> & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    run: commit => {
      asked.push(commit);
      const runs = byCommit[commit]!;
      const findings = runs[Math.min(asked.filter(item => item === commit).length - 1, runs.length - 1)]!;
      return { exec: { exitCode: 0, timedOut: false, output: '' }, report: { kind: 'findings', findings } };
    },
  };
}
const goal = (command: string | undefined): GoalSpec =>
  ({
    baseline: {
      commit: BASE,
      scans: [
        {
          tool: 'app.L5.scan',
          ...(command ? { command } : {}),
          findings: [{ fingerprint: 'fp:old', ruleId: 'old', level: 'error' }],
        },
      ],
    },
  }) as GoalSpec;
const scan = (runner: Pick<ToolRunner, 'run'>, spec: GoalSpec, command: string, recordedIsBase = true) =>
  maintenanceScan({
    runner,
    goal: spec,
    checkId: 'app.L5.scan',
    label: 'app.L5 scan',
    tool: tool(command),
    root: '.',
    head: HEAD,
    base: BASE,
    failOn: 'error',
    recordedIsBase,
  });

describe('maintenanceScan', () => {
  it('uses the base scan the Goal recorded when it was opened, for the same scanner', () => {
    const runner = scanner({ [HEAD]: [[finding('old')]] });
    const got = scan(runner, goal('scan-a'), 'scan-a');
    expect(got.status).toBe('pass');
    expect(runner.asked).toEqual([HEAD, HEAD]);
  });

  it('scans the base again when the setup changed the scanner since the Goal was opened', () => {
    const runner = scanner({
      [HEAD]: [[finding('old'), finding('reported-by-new-scanner')]],
      [BASE]: [[finding('old'), finding('reported-by-new-scanner')]],
    });
    const got = scan(runner, goal('scan-a'), 'scan-b');
    expect(runner.asked).toContain(BASE);
    // The new scanner reports the finding on both sides, so it is not new.
    expect(got.status).toBe('pass');
  });

  it('scans the base again when the record is for another project state, or has no command', () => {
    const runner = scanner({ [HEAD]: [[finding('old')]], [BASE]: [[finding('old')]] });
    scan(runner, goal('scan-a'), 'scan-a', false);
    expect(runner.asked).toContain(BASE);
    const again = scanner({ [HEAD]: [[finding('old')]], [BASE]: [[finding('old')]] });
    scan(again, goal(undefined), 'scan-a');
    expect(again.asked).toContain(BASE);
  });

  it('is red for a new finding at the blocking level, with the fingerprint', () => {
    const got = scan(scanner({ [HEAD]: [[finding('old'), finding('fresh')]] }), goal('scan-a'), 'scan-a');
    expect(got.status).toBe('fail');
    expect(got.reason).toContain('fp:fresh');
  });
});

describe('scanTwice', () => {
  it('is a problem when the two runs show the same finding at different severities', () => {
    const got = scanTwice(
      scanner({ [HEAD]: [[finding('x', 'note')], [finding('x', 'error')]] }),
      HEAD,
      tool('s'),
      '.',
      'l',
    );
    expect('problem' in got && got.problem).toMatch(/different findings/);
  });
});
