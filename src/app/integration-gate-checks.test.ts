import { afterEach, describe, expect, it } from 'vitest';
import { AssuranceService } from './assurance-service.js';
import { GitCommitInspector } from './integration.js';
import { cleanProjects, lockedProject, testingProject } from './test-lock.test-support.js';
import { fileAt, sha256Of } from './git-files.js';
import { reviewRef } from '../domain/review-tests.js';
import { gateReport, proposal, spec } from '../domain/fixtures.test-support.js';
import type { ExecutionProposal } from '../domain/contracts.js';
import type { TestLock } from '../domain/test-lock.js';
import type { GoalState } from '../domain/transitions.js';

afterEach(cleanProjects);

/**
 * The integration commit of a Multi-WP Goal passes the checks a package does: locked tests, test infrastructure, inventory
 * and scope (the union of the green packages' paths, plus the plan's own `paths` for integration files).
 */
async function project(plan: Partial<ExecutionProposal> = {}) {
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
      gate: { ...gateReport(p.lockCommit), changedFiles: [] },
    });
    return {
      ...base,
      proposal: { ...proposal, ...base.proposal, mode: 'multi-wp', ...plan },
      packages: { 'WP-A': pkg('WP-A', ['src/a/**']), 'WP-B': pkg('WP-B', ['src/b/**']) },
    };
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

  it('leaves test infrastructure the tester locked, byte for byte, out of the scope check', async () => {
    const p = await project();
    const head = p.commit({ 'tests/infra.cfg': 'tester config\n', 'src/impl.txt': 'add\n' }, 'integration');
    const base = p.state();
    const state: GoalState = {
      ...base,
      testLock: {
        ...base.testLock!,
        infra: { 'tests/infra.cfg': sha256Of(fileAt(p.dir, head, 'tests/infra.cfg')!) },
      },
    };
    const assurance = new AssuranceService({
      repo: p.dir,
      runner: p.runner,
      inspector: new GitCommitInspector(),
      loadSetup: p.loadSetup,
    });
    const checks = assurance.layerChecks(state, {
      stage: 'integrate',
      scope: p.goalId,
      head,
      base: p.base,
      changed: ['tests/infra.cfg', 'src/impl.txt'],
    }).checks;
    expect(check(checks, 'APOS-INFRA')).toMatchObject({ status: 'pass' });
    expect(check(checks, 'APOS-SCOPE')).toMatchObject({ status: 'pass' });
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
    } satisfies TestLock;
    const closed: GoalState = {
      spec: { ...spec, id: 'GOAL-CAP', kind: 'characterize', covers: ['src/legacy.txt'] },
      status: 'closed',
      selected: true,
      evidence: [],
      reviews: [],
      testLock: lock,
    };
    const assurance = new AssuranceService({
      repo: p.dir,
      runner: p.runner,
      inspector: new GitCommitInspector(),
      loadSetup: p.loadSetup,
      goals: () => [closed],
    });
    const state: GoalState = { ...p.state(), proposal: { ...proposal, ...p.state().proposal, baseCommit: captured } };
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

  it('decides sensitive files: one a package already had approved passes, an integration-only change is red', async () => {
    const p = await project({ paths: ['src/**', 'pyproject.toml', 'tests/infra.cfg'] });
    const base = p.state();
    const delivered = p.commit({ 'pyproject.toml': 'dep\n', 'tests/infra.cfg': 'plain2\n' }, 'package delivery');
    const withPackage = (): GoalState => {
      const state = base;
      const pkg = {
        spec: { ...state.packages!['WP-MAIN']!.spec, id: 'WP-A', paths: ['src/a/**'], stubPaths: [], dependencies: [] },
        status: 'green' as const,
        attempts: 0,
        gate: { ...gateReport(delivered), changedFiles: ['pyproject.toml', 'tests/infra.cfg'] },
      };
      return { ...state, proposal: { ...proposal, ...state.proposal, mode: 'multi-wp' }, packages: { 'WP-A': pkg } };
    };
    const assurance = new AssuranceService({
      repo: p.dir,
      runner: p.runner,
      inspector: new GitCommitInspector(),
      loadSetup: p.loadSetup,
    });
    const at = (head: string) =>
      assurance.layerChecks(withPackage(), {
        stage: 'integrate',
        scope: p.goalId,
        head,
        base: p.lockCommit,
        changed: ['pyproject.toml', 'tests/infra.cfg'],
      }).checks;
    const same = at(delivered);
    expect(check(same, 'APOS-SCOPE')).toMatchObject({ status: 'pass' });
    expect(check(same, 'APOS-INFRA')).toMatchObject({ status: 'pass' });
    const again = at(
      p.commit({ 'pyproject.toml': 'another dep\n', 'tests/infra.cfg': 'plain3\n' }, 'integration edits'),
    );
    expect(check(again, 'APOS-SCOPE')).toMatchObject({ status: 'fail' });
    expect(check(again, 'APOS-SCOPE').reason).toContain('pyproject.toml');
    expect(check(again, 'APOS-INFRA')).toMatchObject({ status: 'needs-human' });
  }, 120_000);

  it('lets a package review test outside the plan paths stand, byte for byte, and rejects an edit of it', async () => {
    const p = await project({ paths: ['src/**'] });
    const review = p.commit({ 'docs/review.t': 'case r pass\n' }, 'package review test');
    const state: GoalState = {
      ...p.state(),
      reviewTests: [
        {
          packageId: 'WP-MAIN',
          deliveryCommit: p.lockCommit,
          reviewCommit: review,
          files: { 'docs/review.t': sha256Of(fileAt(p.dir, review, 'docs/review.t')!) },
          tests: [{ part: 'app', layer: 'L2', id: 'x::r' }],
          blocking: [{ part: 'app', layer: 'L2', id: 'x::r' }],
          alsoRedBefore: [],
          by: 'reviewer',
        },
      ],
    };
    const assurance = new AssuranceService({
      repo: p.dir,
      runner: p.runner,
      inspector: new GitCommitInspector(),
      loadSetup: p.loadSetup,
    });
    const at = (head: string) =>
      check(
        assurance.layerChecks(state, {
          stage: 'integrate',
          scope: p.goalId,
          head,
          base: p.lockCommit,
          changed: ['docs/review.t'],
        }).checks,
        'APOS-SCOPE',
      );
    expect(at(review)).toMatchObject({ status: 'pass' });
    const edited = at(p.commit({ 'docs/review.t': 'case r pass\ncase more pass\n' }, 'edit'));
    expect(edited.status).toBe('fail');
    expect(edited.reason).toContain('docs/review.t');
  }, 120_000);

  it('lets the edit of an overridden package review test stand where the green package delivered it', async () => {
    const p = await project({ paths: ['src/**'] });
    const review = p.commit({ 'docs/review.t': 'case r pass\n' }, 'package review test');
    const delivered = p.commit({ 'docs/review.t': 'case r pass\ncase more pass\n' }, 'package edits the test');
    const lock = {
      packageId: 'WP-MAIN',
      deliveryCommit: p.lockCommit,
      reviewCommit: review,
      files: { 'docs/review.t': sha256Of(fileAt(p.dir, review, 'docs/review.t')!) },
      tests: [{ part: 'app', layer: 'L2', id: 'x::r' }],
      blocking: [{ part: 'app', layer: 'L2', id: 'x::r' }],
      alsoRedBefore: [],
      by: 'reviewer',
    } satisfies NonNullable<GoalState['reviewTests']>[number];
    const base = p.state();
    const main = base.packages!['WP-MAIN']!;
    const state: GoalState = {
      ...base,
      packages: { 'WP-MAIN': { ...main, gate: { ...gateReport(delivered), changedFiles: ['docs/review.t'] } } },
      reviewTests: [lock],
      exceptions: [
        {
          kind: 'review-overridden',
          ref: reviewRef(lock, base.spec.id),
          commit: delivered,
          reason: 'the package rewrote it',
          by: 'agent:lead',
          at: '2026-01-01T00:00:00Z',
        },
      ],
    };
    const assurance = new AssuranceService({
      repo: p.dir,
      runner: p.runner,
      inspector: new GitCommitInspector(),
      loadSetup: p.loadSetup,
    });
    const at = (head: string) =>
      check(
        assurance.layerChecks(state, {
          stage: 'integrate',
          scope: p.goalId,
          head,
          base: p.lockCommit,
          changed: ['docs/review.t'],
        }).checks,
        'APOS-SCOPE',
      );
    expect(at(delivered)).toMatchObject({ status: 'pass' });
    const again = at(p.commit({ 'docs/review.t': 'case r pass\ncase other pass\n' }, 'integration-only edit'));
    expect(again.status).toBe('fail');
    expect(again.reason).toContain('docs/review.t');
  }, 120_000);

  it('leaves a locked test file to APOS-LOCKED even when needsHuman globs match it', async () => {
    const p = await project();
    const head = p.commit({ 'src/impl.txt': 'add\n' }, 'integration');
    const setup = p.loadSetup(p.state());
    const part = setup.parts.app!;
    const assurance = new AssuranceService({
      repo: p.dir,
      runner: p.runner,
      inspector: new GitCommitInspector(),
      loadSetup: () => ({ ...setup, parts: { app: { ...part, needsHuman: ['tests/acceptance/**'] } } }),
    });
    const checks = assurance.layerChecks(p.state(), {
      stage: 'integrate',
      scope: p.goalId,
      head,
      base: p.base,
      changed: ['tests/acceptance/calc.t', 'src/impl.txt'],
    }).checks;
    expect(check(checks, 'APOS-SCOPE')).toMatchObject({ status: 'pass' });
  }, 120_000);
});
