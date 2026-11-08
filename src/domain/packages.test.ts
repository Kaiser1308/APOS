import { describe, expect, it } from 'vitest';
import { parseWorkPackage, validatePackageGraph } from './packages.js';
import { spec, proposal } from './fixtures.test-support.js';

const a = {
  id: 'WP-01', goalId: 'GOAL-001', goalVersion: 1, version: 1,
  owner: 'worker-a', outcome: 'QR intake works', scope: ['scanner'], exclusions: ['reports'],
  dependencies: [], interfaces: ['checkIn(token) -> result@v1'],
  acceptance: [{ id: 'WP-AC-1', text: 'valid token checks in', goalAcceptanceId: 'AC-1' }],
  integration: 'Lead runs check-in flow'
};
const b = { ...a, id: 'WP-02', owner: 'worker-b', outcome: 'QR audit history works', acceptance: [{ id: 'WP-AC-2', text: 'history saved' }] };
const multi = { ...proposal, mode: 'multi-wp' as const };

describe('Work Package graph', () => {
  it('accepts two independent cohesive packages', () => {
    expect(() => validatePackageGraph(spec, multi, [a, b])).not.toThrow();
    expect(parseWorkPackage(a).id).toBe('WP-01');
  });
  it('accepts a dependency on an existing package', () => {
    expect(() => validatePackageGraph(spec, multi, [a, { ...b, dependencies: ['WP-01'] }])).not.toThrow();
  });
  it('rejects dependency cycles', () => {
    expect(() => validatePackageGraph(spec, multi, [{ ...a, dependencies: ['WP-02'] }, { ...b, dependencies: ['WP-01'] }])).toThrow(/cycle/i);
  });
  it('rejects missing dependency and duplicate package IDs', () => {
    expect(() => validatePackageGraph(spec, multi, [a, { ...b, dependencies: ['WP-99'] }])).toThrow(/dependency/i);
    expect(() => validatePackageGraph(spec, multi, [a, { ...b, id: 'WP-01' }])).toThrow(/duplicate/i);
  });
  it('rejects a Goal criterion with no package or Goal-level mapping', () => {
    expect(() => validatePackageGraph(spec, multi, [{ ...a, acceptance: [{ id: 'WP-AC-1', text: 'valid token checks in' }] }, b])).toThrow(/AC-1/);
  });
  it('rejects a shared interface without a version', () => {
    expect(() => validatePackageGraph(spec, multi, [{ ...a, interfaces: ['checkIn(token)'] }, b])).toThrow(/needs a version/);
  });
  it('rejects an empty package outcome', () => {
    expect(() => parseWorkPackage({ ...a, outcome: ' ' })).toThrow();
  });
});
