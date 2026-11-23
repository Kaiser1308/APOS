import { describe, expect, it } from 'vitest';
import { buildAssuranceReport, renderAssuranceText } from './assurance-report.js';
import type { CheckResult, GateReport } from './gate.js';
import { parseSetupObject } from './project-setup.js';
import type { GoalState } from './transitions.js';
import { gateReport, spec } from './fixtures.test-support.js';

const check = (checkId: string, status: CheckResult['status'], extra: Partial<CheckResult> = {}): CheckResult => ({
  checkId,
  status,
  reason: 'r',
  base: [],
  delivery: [],
  newFailures: [],
  ...extra,
});
const gate = (
  layers: GateReport['layers'],
  checks: CheckResult[],
  phase: GateReport['phase'] = 'delivery',
): GateReport => ({
  ...gateReport(),
  phase,
  layers,
  checks,
});
const base: GoalState = { spec, status: 'executing', selected: true, evidence: [], reviews: [], setupVersion: 3 };
const run = (layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L5', tool: string, format = 'junit', extra: object = {}) => ({
  part: 'app',
  layer,
  tool,
  format,
  why: 'floor' as const,
  ...extra,
});

describe('buildAssuranceReport', () => {
  it('counts criteria by who proves them', () => {
    const goal = {
      ...spec,
      acceptance: [
        spec.acceptance[0]!,
        { ...spec.acceptance[0]!, id: 'AC-2', proof: 'manual' as const },
        { ...spec.acceptance[0]!, id: 'AC-3', proof: 'benchmark' as const, checkIds: [] },
      ],
    };
    expect(buildAssuranceReport({ ...base, spec: goal }).criteria).toEqual({
      total: 3,
      machine: 2,
      manual: 1,
      byProof: { 'red-green': 1, manual: 1, benchmark: 1 },
    });
  });

  it('says there is no setup, and nothing about it is guarded', () => {
    const report = buildAssuranceReport({ ...base, setupVersion: undefined });
    expect(report.setup).toBeUndefined();
    expect(report.guards).toBe(false);
    expect(report.off).toContain('mọi bảo đảm theo setup tắt: Goal không có setup');
    expect(renderAssuranceText(report).split('\n')[0]).toBe('GOAL-001  không có setup');
  });

  it('reads layer rows from the plan a gate recorded: pass, fail, unverifiable, reduced, and a tool with no check', () => {
    const state: GoalState = {
      ...base,
      packages: {
        'WP-MAIN': {
          spec: { id: 'WP-MAIN' } as never,
          status: 'green',
          attempts: 0,
          gate: gate(
            {
              stage: 'submit',
              runs: [
                run('L0', 'lint', 'exit'),
                run('L1', 'unit'),
                run('L2', 'acc'),
                run('L3', 'integ', 'junit', { reduced: true, why: 'lead' }),
                run('L5', 'scan', 'sarif'),
              ],
              skipped: ['app.L5.mut tắt: Goal không gắn cờ mutation'],
            },
            [check('app.L0.lint', 'pass'), check('app.L1.unit', 'fail'), check('app.L2.acc', 'unverifiable')],
          ),
        },
      },
    };
    const report = buildAssuranceReport(state);
    expect(report.layers.map(row => `${row.layer}:${row.status}`)).toEqual([
      'L0:pass',
      'L1:fail',
      'L2:unverifiable',
      'L3:reduced',
      'L5:not-run',
    ]);
    expect(report.layers.every(row => row.stage === 'submit' && row.scope === 'WP-MAIN')).toBe(true);
    expect(report.off).toContain('app.L5.mut tắt: Goal không gắn cờ mutation');
    expect(report.exitOnly).toEqual(['app.L0.lint']);
  });

  it('shows what a SARIF layer found below the blocking level, and a metric', () => {
    const state: GoalState = {
      ...base,
      status: 'verified',
      closeGate: gate(
        { stage: 'close', runs: [run('L5', 'scan', 'sarif'), run('L5', 'bench', 'metric')], skipped: [] },
        [
          check('app.L5.scan', 'pass', { findings: { blocking: 0, lower: 3 } }),
          check('app.L5.bench', 'pass', { metric: { name: 'p95_ms', value: 160 } }),
        ],
        'close',
      ),
    };
    const rows = buildAssuranceReport(state).layers;
    expect(rows.map(row => row.note)).toEqual(['3 finding dưới mức chặn', 'p95_ms 160']);
    expect(rows.every(row => row.stage === 'close' && row.scope === 'goal')).toBe(true);
  });

  it('a tool with several metrics shows the worst of its checks, with every note', () => {
    const state: GoalState = {
      ...base,
      status: 'verified',
      closeGate: gate(
        { stage: 'close', runs: [run('L5', 'bench', 'metric')], skipped: [] },
        [
          check('app.L5.bench', 'pass', { metric: { name: 'p95_ms', value: 150 } }),
          check('app.L5.bench:throughput', 'fail', { metric: { name: 'throughput', value: 900 } }),
        ],
        'close',
      ),
    };
    expect(buildAssuranceReport(state).layers).toEqual([
      expect.objectContaining({ tool: 'bench', status: 'fail', note: 'p95_ms 150; throughput 900' }),
    ]);
  });

  it('lists the close layers as not run yet when the setup is given', () => {
    const parsed = parseSetupObject({
      schemaVersion: 2,
      parts: {
        app: { root: '.', stack: 'python', layers: { L1: [{ id: 'unit', command: 'x {report}', format: 'junit' }] } },
      },
    });
    if (parsed.version !== 2) throw new Error('fixture');
    const report = buildAssuranceReport(base, parsed.setup);
    expect(report.setup).toEqual({ version: 3, parts: { app: 'python' } });
    expect(report.layers).toEqual([
      { stage: 'close', scope: 'goal', part: 'app', layer: 'L1', tool: 'unit', why: 'floor', status: 'not-run' },
    ]);
  });

  it('counts locked tests by layer and tells an automatic re-lock from an approved weakening', () => {
    const lock = {
      commit: 'c'.repeat(40),
      files: {},
      asserts: {},
      map: [
        { acceptanceId: 'AC-1', part: 'app', layer: 'L2' as const, testIds: ['a', 'b'] },
        { acceptanceId: 'AC-1', part: 'app', layer: 'L3' as const, testIds: ['c'] },
      ],
      by: 't',
      unchecked: ['app'],
    };
    const report = buildAssuranceReport({
      ...base,
      testLock: lock,
      testRevisions: 2,
      exceptions: [
        {
          kind: 'tests-weakened',
          ref: 'x'.repeat(40),
          commit: 'c'.repeat(40),
          reason: 'dropped dup',
          by: 'agent:lead',
          at: 't',
        },
      ],
    });
    expect(report.lockedTests).toEqual({
      byLayer: { L2: 2, L3: 1 },
      revisions: 2,
      autoRelocked: 1,
      approvedWeakenings: 1,
    });
    expect(report.off).toContain('test chỉ gọi qua cửa: app chưa kiểm (danh mục chưa có luật)');
  });

  it('names who approved each exception: the Human, the Human by proxy, or an agent', () => {
    const entry = (by: string, extra: object = {}) => ({
      kind: 'floor-reduced',
      ref: 'WP-MAIN:submit:L2',
      commit: 'c'.repeat(40),
      reason: 'r',
      by,
      at: 't',
      ...extra,
    });
    const report = buildAssuranceReport({
      ...base,
      exceptions: [
        entry('human', { confirmation: { by: 'human' } }),
        entry('human', { confirmation: { by: 'on-behalf', onBehalf: 'item 7' } }),
        entry('agent:lead'),
      ],
    });
    expect(report.exceptions.map(item => item.by)).toEqual(['human', 'on-behalf:item 7', 'agent:lead']);
  });
});

describe('renderAssuranceText', () => {
  it('is stable text: setup, criteria, locked tests, guards, layers per stage, exceptions, agent approvals, what is off', () => {
    const state: GoalState = {
      ...base,
      testLock: {
        commit: 'c'.repeat(40),
        files: {},
        asserts: {},
        map: [{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['a'] }],
        by: 't',
      },
      testRevisions: 1,
      exceptions: [
        {
          kind: 'floor-reduced',
          ref: 'WP-MAIN:submit:L3',
          commit: 'c'.repeat(40),
          reason: 'docs only',
          by: 'agent:lead',
          at: 't',
        },
      ],
      packages: {
        'WP-MAIN': {
          spec: { id: 'WP-MAIN' } as never,
          status: 'green',
          attempts: 0,
          gate: gate(
            {
              stage: 'submit',
              runs: [
                run('L1', 'unit'),
                run('L3', 'integ', 'junit', { reduced: true }),
                run('L5', 'scan', 'sarif', { why: 'proof' }),
              ],
              skipped: ['app.L5.mut tắt: Goal không gắn cờ mutation'],
            },
            [check('app.L1.unit', 'pass'), check('app.L5.scan', 'pass', { findings: { blocking: 0, lower: 2 } })],
          ),
        },
      },
    };
    expect(renderAssuranceText(buildAssuranceReport(state))).toMatchInlineSnapshot(`
      "GOAL-001  setup v3
        Tiêu chí           1   máy chứng minh 1 · anh xác nhận tay 0
        Test đã khoá       L2 1      sửa sau khoá: 1 (máy tự khoá lại 1, duyệt bớt assert 0)
        Kiểm kê / phạm vi  bật
        Lớp khâu submit    WP-MAIN: L1 unit ✓ · L3 integ bớt · L5 scan (tiêu chí) ✓ (2 finding dưới mức chặn)
        Ngoại lệ           floor-reduced WP-MAIN:submit:L3 (agent:lead): docs only
        Agent duyệt thay   1 chỗ: floor-reduced WP-MAIN:submit:L3 (agent:lead)
        Tắt / chưa kiểm    app.L5.mut tắt: Goal không gắn cờ mutation"
    `);
  });
});

describe('mutation in the table', () => {
  const setup = parseSetupObject({
    schemaVersion: 2,
    parts: {
      app: {
        root: '.',
        layers: {
          L1: [{ id: 'pytest', command: 'pytest', format: 'junit' }],
          L5: [{ id: 'mutate', command: 'x', format: 'metric', metric: 'mutationScore', when: 'flag:mutation' }],
        },
      },
    },
  });
  const parsed = setup.version === 2 ? setup.setup : undefined;

  it('says mutation is off when the setup has the tool and the Goal has no flag', () => {
    const text = renderAssuranceText(buildAssuranceReport(base, parsed));
    expect(text).toContain('mutation tắt (Goal không gắn cờ)');
  });
  it('does not say so when the Goal carries the flag (in its document or from the approval), and lists the layer', () => {
    for (const goal of [
      { ...base, spec: { ...spec, flags: ['mutation'] } },
      { ...base, flags: ['mutation'] },
    ]) {
      const text = renderAssuranceText(buildAssuranceReport(goal, parsed));
      expect(text).not.toContain('mutation tắt');
      expect(text).toContain('L5 mutate');
    }
  });
  it('says nothing when the setup has no mutation tool', () => {
    expect(renderAssuranceText(buildAssuranceReport(base))).not.toContain('mutation');
  });
});
