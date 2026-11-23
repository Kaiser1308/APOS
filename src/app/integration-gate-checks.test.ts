import { afterEach, describe, expect, it } from 'vitest';
import { AssuranceService } from './assurance-service.js';
import { GitCommitInspector } from './integration.js';
import { cleanProjects, lockedProject, testingProject } from './test-lock.test-support.js';
import { fileAt, sha256Of } from './git-files.js';
import { spec } from '../domain/fixtures.test-support.js';
import type { TestLock } from '../domain/test-lock.js';
import type { GoalState } from '../domain/transitions.js';

afterEach(cleanProjects);

/**
 * The integration commit of a Multi-WP Goal passes the checks a package does: locked tests, test infrastructure, inventory
 * and scope (the union of the green packages' paths, plus the plan's own `paths` for integration files).
 */
async function project(plan: object = {}) {
  const p = await lockedProject({ plan: { paths: ['src/**', 'tests/unit/**'], ...plan } });
  const changed = (head: string) => p.git('diff', '--name-only', p.base, head).split('\n').filter(Boolean);
  const assurance = new AssuranceService({
    repo: p.dir,
    runner: p.runner,
    inspector: new GitCommitInspector(),
    loadSetup: p.loadSetup,
    goals: () => p.journal.listGoals(),
  });
  /** The Goal as the integration gate sees it: two packages, each green and scoped to its own files. */
  const state = (): GoalState => {
    const base = p.state();
    const pkg = (id: string, paths: string[]) => ({
      spec: { ...base.packages!['WP-MAIN']!.spec, id, paths, stubPaths: ['src/stub.txt'], dependencies: [] },
      status: 'green' as const,
      attempts: 0,
      gate: { changedFiles: [], deliveryCommit: p.lockCommit },
    });
    return {
      ...base,
      proposal: { ...base.proposal!, mode: 'multi-wp', ...plan },
      packages: { 'WP-A': pkg('WP-A', ['src/a/**']), 'WP-B': pkg('WP-B', ['src/b/**']) },
    } as unknown as GoalState;
  };
  const run = (head: string) =>
    assurance.layerChecks(state(), {
      stage: 'integrate',
      scope: p.goalId,
      head,
      base: p.lockCommit,
      changed: changed(head),
    }).checks;
  return { ...p, run };
}
const check = (checks: { checkId: string }[], id: string) =>
  checks.find(item => item.checkId === id) as never as {
    status: string;
    reason: string;
  };

describe('the integration gate runs the package checks on the integration commit', () => {
  it('passes an integration commit that keeps the locked tests and stays inside the packages', async () => {
    const p = await project();
    const head = p.commit({ 'src/a/x.txt': 'a\n', 'src/b/y.txt': 'b\n', 'src/impl.txt': 'add\n' }, 'integration');
    const checks = p.run(head);
    for (const id of ['APOS-LOCKED', 'APOS-INVENTORY', 'APOS-INFRA'])
      expect(check(checks, id), id).toMatchObject({ status: 'pass' });
    // src/impl.txt is outside every package: the plan's own paths (src/**) are what allows it.
    expect(check(checks, 'APOS-SCOPE')).toMatchObject({ status: 'pass' });
  }, 120_000);

  it('is red when the integration commit rewrites a locked test', async () => {
    const p = await project();
    const head = p.commit({ 'tests/acceptance/calc.t': 'case add pass\n', 'src/impl.txt': 'add\n' }, 'weaken it');
    const locked = check(p.run(head), 'APOS-LOCKED');
    expect(locked.status).toBe('fail');
    expect(locked.reason).toContain('locked test modified: tests/acceptance/calc.t');
  }, 120_000);

  it('is red when the integration commit deletes a locked test, or any test that ran at the base', async () => {
    const p = await project();
    const head = p.commit(
      { 'tests/acceptance/calc.t': null, 'tests/unit/u.t': null, 'src/impl.txt': 'add\n' },
      'delete',
    );
    const checks = p.run(head);
    expect(check(checks, 'APOS-LOCKED').reason).toContain('(deleted)');
    expect(check(checks, 'APOS-INVENTORY')).toMatchObject({ status: 'fail' });
    expect(check(checks, 'APOS-INVENTORY').reason).toContain('tests.unit.u::one');
  }, 120_000);

  it('needs a decision when test infrastructure changes', async () => {
    const p = await project();
    const head = p.commit({ 'tests/infra.cfg': 'swallow\n', 'src/impl.txt': 'add\n' }, 'infra');
    expect(check(p.run(head), 'APOS-INFRA')).toMatchObject({ status: 'needs-human' });
  }, 120_000);

  it('is red for a file outside the packages and the plan paths, naming it', async () => {
    const p = await project({ paths: ['src/impl.txt'] });
    const head = p.commit({ 'src/impl.txt': 'add\n', 'src/a/x.txt': 'a\n', 'docs/rogue.md': 'x\n' }, 'integration');
    const scope = check(p.run(head), 'APOS-SCOPE');
    expect(scope.status).toBe('fail');
    expect(scope.reason).toContain('docs/rogue.md');
    expect(scope.reason).not.toContain('src/a/x.txt');
  }, 120_000);

  it('holds a refactor to its captured tests at the integration commit', async () => {
    const refactor = { ...spec, kind: 'refactor' as const, paths: ['src/legacy.txt'], acceptance: [], checks: [] };
    const p = await testingProject({ goal: refactor, files: { 'src/legacy.txt': 'legacy\n' }, paths: ['src/**'] });
    const captured = p.commit({ 'tests/acceptance/calc.t': 'case add pass\n' }, 'captured tests');
    const lock = {
      commit: captured,
      files: { 'tests/acceptance/calc.t': sha256Of(fileAt(p.dir, captured, 'tests/acceptance/calc.t')!) },
      asserts: {},
      map: [{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['tests.acceptance.calc::add'] }],
      by: 't',
    } as TestLock;
    const closed = {
      spec: { ...spec, id: 'GOAL-CAP', kind: 'characterize', covers: ['src/legacy.txt'] },
      status: 'closed',
      testLock: lock,
    } as unknown as GoalState;
    const assurance = new AssuranceService({
      repo: p.dir,
      runner: p.runner,
      inspector: new GitCommitInspector(),
      loadSetup: p.loadSetup,
      goals: () => [closed],
    });
    const state = { ...p.state(), proposal: { ...p.state().proposal!, baseCommit: captured } } as GoalState;
    const at = (head: string) =>
      check(
        assurance.layerChecks(state, { stage: 'integrate', scope: p.goalId, head, base: captured, changed: [] }).checks,
        'APOS-CHARACTERIZED',
      );
    expect(at(p.commit({ 'src/legacy.txt': 'tidied\n' }, 'tidy'))).toMatchObject({ status: 'pass' });
    const broken = at(p.commit({ 'tests/acceptance/calc.t': 'case add fail nope\n' }, 'break it'));
    expect(broken.status).toBe('fail');
    expect(broken.reason).toContain('GOAL-CAP');
  }, 120_000);
});
