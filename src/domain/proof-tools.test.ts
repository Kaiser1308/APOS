import { describe, expect, it } from 'vitest';
import { parseGoalSpec } from './contracts.js';
import { proofDemands, proofToolProblems } from './proof-tools.js';
import { parseSetupObject } from './project-setup.js';
import { spec } from './fixtures.test-support.js';

const criterion = (id: string, extra: object) => ({ ...spec.acceptance[0]!, id, checkIds: [], ...extra });
const goal = (...criteria: object[]) => parseGoalSpec({ ...spec, acceptance: [spec.acceptance[0], ...criteria] });
const setup = (() => {
  const parsed = parseSetupObject({
    schemaVersion: 2,
    parts: {
      api: {
        root: '.',
        layers: {
          L5: [
            { id: 'bench', command: 'b {report}', format: 'metric', metric: 'p95_ms' },
            { id: 'scan', command: 's {report}', format: 'sarif' },
          ],
        },
      },
    },
  });
  if (parsed.version !== 2) throw new Error('fixture');
  return parsed.setup;
})();
const bench = { proof: 'benchmark', benchmark: { tool: 'api.L5.bench', metric: 'p95_ms', op: '<', value: 200 } };
const scan = { proof: 'scan', scan: { tool: 'api.L5.scan', failOn: 'warning' } };

describe('non-functional criteria in the Goal contract', () => {
  it('a benchmark or scan criterion needs no Goal check; a functional one still does', () => {
    expect(() => goal(criterion('AC-2', bench), criterion('AC-3', scan))).not.toThrow();
    expect(() => goal(criterion('AC-2', {}))).toThrow(/needs at least one check/);
  });
  it('proof and its details must agree', () => {
    expect(() => goal(criterion('AC-2', { proof: 'benchmark' }))).toThrow(/no benchmark/);
    expect(() => goal(criterion('AC-2', { proof: 'scan' }))).toThrow(/no scan/);
    expect(() => goal(criterion('AC-2', { ...scan, proof: 'red-green', checkIds: ['CHK-1'] }))).toThrow(
      /has a scan but its proof is not/,
    );
    expect(() => goal(criterion('AC-2', { ...bench, benchmark: { ...bench.benchmark, tool: 'nonsense' } }))).toThrow(
      /<part>\.<layer>\.<id>/,
    );
  });
});

describe('proofDemands', () => {
  it('groups by tool: thresholds per metric, and the strictest blocking level', () => {
    const g = goal(
      criterion('AC-2', bench),
      criterion('AC-3', { ...bench, benchmark: { ...bench.benchmark, op: '>', value: 10 } }),
      criterion('AC-4', scan),
      criterion('AC-5', { ...scan, scan: { tool: 'api.L5.scan', failOn: 'error' } }),
    );
    expect(proofDemands(g)).toEqual([
      {
        tool: 'api.L5.bench',
        metrics: [
          {
            name: 'p95_ms',
            thresholds: [
              { op: '<', value: 200 },
              { op: '>', value: 10 },
            ],
            criteria: ['AC-2', 'AC-3'],
          },
        ],
        criteria: ['AC-2', 'AC-3'],
      },
      { tool: 'api.L5.scan', metrics: [], failOn: 'warning', criteria: ['AC-4', 'AC-5'] },
    ]);
  });
});

describe('proofToolProblems', () => {
  it('is empty when the tools exist with the right format', () => {
    expect(proofToolProblems(goal(criterion('AC-2', bench), criterion('AC-3', scan)), setup)).toEqual([]);
  });
  it('names the criterion and the tool that is missing or of the wrong kind', () => {
    const missing = { ...bench, benchmark: { ...bench.benchmark, tool: 'api.L5.nope' } };
    const wrong = { ...scan, scan: { tool: 'api.L5.bench', failOn: 'error' } };
    expect(proofToolProblems(goal(criterion('AC-2', missing), criterion('AC-3', wrong)), setup)).toEqual([
      'AC-2 benchmark: the tool api.L5.nope is not in the pinned setup',
      'AC-3 scan: api.L5.bench reports metric, a scan needs a sarif tool',
    ]);
  });
});
