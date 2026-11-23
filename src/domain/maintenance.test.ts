import { describe, expect, it } from 'vitest';
import { parseGoalSpec } from './contracts.js';
import type { CheckResult } from './gate.js';
import {
  maintenanceGoalSpec,
  maintenanceProposal,
  maintenanceScope,
  nextMaintenanceId,
  scanTools,
  securityCheck,
} from './maintenance.js';
import { parseSetupObject, type ProjectSetup } from './project-setup.js';

const setupOf = (parts: Record<string, unknown>): ProjectSetup => {
  const parsed = parseSetupObject({ schemaVersion: 2, parts });
  if (parsed.version !== 2) throw new Error('fixture');
  return parsed.setup;
};
const scanned = (fixed: string[], remaining: string[]): CheckResult => ({
  checkId: 'app.L5.scan',
  status: 'pass',
  reason: '',
  base: [],
  delivery: [],
  newFailures: [],
  scan: { baseCommit: 'b', baseTotal: 2, newBlocking: 0, newLower: 0, fixed, remaining },
});

describe('maintenance Goal', () => {
  const goal = maintenanceGoalSpec({
    id: 'GOAL-MAINT-001',
    request: { description: 'Bump fmt', security: [], paths: ['src/**'] },
    now: '2026-11-23T00:00:00Z',
  });
  it('has no criterion and no check, a source hashed from the request, and is not a sketch', () => {
    expect(goal).toMatchObject({ kind: 'maintenance', acceptance: [], checks: [], paths: ['src/**'] });
    expect(goal.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('refuses a criterion or a check written by hand', () => {
    const withCriterion = { ...goal, acceptance: [{ id: 'AC-1', text: 't', requirementIds: ['R-1'], checkIds: [] }] };
    expect(() => parseGoalSpec(withCriterion)).toThrow(/no criterion or check of its own/);
  });
  it('takes the next free GOAL-MAINT number and leaves other ids alone', () => {
    expect(nextMaintenanceId(['GOAL-1', 'GOAL-BUG-004'])).toBe('GOAL-MAINT-001');
    expect(nextMaintenanceId(['GOAL-MAINT-001', 'GOAL-MAINT-007'])).toBe('GOAL-MAINT-008');
  });
});

describe('the scope and the plan of a maintenance Goal', () => {
  const setup = setupOf({
    api: { root: 'api', layers: {}, manifests: ['package.json'] },
    web: {
      root: 'web',
      layers: {
        L5: [
          { id: 'scan', command: 's {report}', format: 'sarif' },
          { id: 'm', command: 'm', format: 'exit' },
        ],
      },
      manifests: ['pom.xml'],
    },
  });
  const goal = (extra: Record<string, unknown>) =>
    maintenanceGoalSpec({
      id: 'GOAL-MAINT-001',
      request: { description: 'd', security: [], paths: ['api/src/**'], ...extra },
      now: '2026-11-23T00:00:00Z',
    });
  it('is the manifests of its part (every part when none is named) and the declared paths, rooted at the repo', () => {
    expect(maintenanceScope(setup, goal({ part: 'api' }))).toEqual(['api/package.json', 'api/src/**']);
    expect(maintenanceScope(setup, goal({}))).toEqual(['api/package.json', 'web/pom.xml', 'api/src/**']);
  });
  it('names only the scan tools that report findings and run without a flag', () => {
    expect(scanTools(setup).map(item => item.key)).toEqual(['web.L5.scan']);
    expect(scanTools(setup, 'api')).toEqual([]);
  });
  it('plans one Solo package with that scope, no criterion mapped, and refuses a setup with no manifests', () => {
    const plan = maintenanceProposal({ goal: goal({ part: 'api' }), version: 1, baseCommit: 'a'.repeat(40), setup });
    expect(plan).toMatchObject({
      mode: 'solo-direct',
      acceptanceMapping: [],
      paths: ['api/package.json', 'api/src/**'],
    });
    const bare = setupOf({ app: { root: '.', layers: {} } });
    expect(() => maintenanceProposal({ goal: goal({}), version: 1, baseCommit: 'a'.repeat(40), setup: bare })).toThrow(
      /lists no manifests/,
    );
  });
});

describe('securityCheck', () => {
  it('passes when every named finding was on the base and is gone', () => {
    expect(securityCheck(['f1'], [scanned(['f1'], ['f2'])]).status).toBe('pass');
  });
  it('fails when a named finding remains, or no scan judged it', () => {
    expect(securityCheck(['f2'], [scanned(['f1'], ['f2'])])).toMatchObject({
      status: 'fail',
      reason: expect.stringContaining('vẫn còn'),
    });
    expect(securityCheck(['f9'], [scanned(['f1'], ['f2'])])).toMatchObject({
      status: 'fail',
      reason: expect.stringContaining('không tái hiện được finding trên base'),
    });
    expect(securityCheck(['f1'], []).status).toBe('fail');
  });
});
