import { afterEach, describe, expect, it } from 'vitest';
import { AssuranceService } from './assurance-service.js';
import { GitCommitInspector } from './integration.js';
import { cleanProjects, mapFor, testingProject } from './test-lock.test-support.js';
import { spec } from '../domain/fixtures.test-support.js';

afterEach(cleanProjects);

/** The integration commit of a Multi-WP Goal, and the close stage, are bound by what the Human approved (Codex review of #45). */
const refactor = { ...spec, kind: 'refactor' as const, paths: ['src/legacy.txt'], acceptance: [], checks: [] };
const characterize = { ...spec, kind: 'characterize' as const, covers: ['src/legacy.txt'] };
const files = { 'src/impl.txt': 'add\n', 'src/legacy.txt': 'legacy\n', 'src/other.txt': 'other\n' };

const service = (p: Awaited<ReturnType<typeof testingProject>>) =>
  new AssuranceService({
    repo: p.dir,
    runner: p.runner,
    inspector: new GitCommitInspector(),
    loadSetup: p.loadSetup,
    goals: () => p.journal.listGoals(),
  });

describe('layerChecks of a legacy Goal at the integrate and close stages', () => {
  it('is red for a refactor whose integration commit touches a file outside the Goal paths', async () => {
    const p = await testingProject({ goal: refactor, files });
    const head = p.commit({ 'src/legacy.txt': 'tidied\n', 'src/other.txt': 'changed\n' }, 'integration');
    for (const stage of ['integrate', 'close'] as const) {
      const ran = service(p).layerChecks(p.state(), {
        stage,
        scope: p.goalId,
        head,
        base: p.base,
        changed: ['src/legacy.txt', 'src/other.txt'],
      });
      const scope = ran.checks.find(check => check.checkId === 'APOS-REFACTOR-SCOPE');
      expect(scope, stage).toMatchObject({ status: 'fail' });
      expect(scope?.reason, stage).toContain('src/other.txt');
    }
  }, 120_000);

  it('is red for a sensitive file only the integration changed, and not for one a package gate saw', async () => {
    const p = await testingProject({ goal: refactor, files: { ...files, 'pyproject.toml': 'x\n' } });
    const head = p.commit({ 'pyproject.toml': 'changed\n' }, 'integration');
    const input = { stage: 'integrate' as const, scope: p.goalId, head, base: p.base, changed: ['pyproject.toml'] };
    const scope = (state = p.state()) =>
      service(p)
        .layerChecks(state, input)
        .checks.find(check => check.checkId === 'APOS-REFACTOR-SCOPE');
    expect(scope()).toMatchObject({ status: 'fail' });
    expect(scope()?.reason).toContain('pyproject.toml');
    const judged = {
      ...p.state(),
      packages: { 'WP-A': { spec: {}, gate: { changedFiles: ['pyproject.toml'] } } },
    } as unknown as ReturnType<typeof p.state>;
    expect(scope(judged)).toMatchObject({ status: 'pass' });
  }, 120_000);

  it('passes for a refactor that stays inside, so nothing else changes', async () => {
    const p = await testingProject({ goal: refactor, files });
    const head = p.commit({ 'src/legacy.txt': 'tidied\n' }, 'integration');
    const ran = service(p).layerChecks(p.state(), {
      stage: 'integrate',
      scope: p.goalId,
      head,
      base: p.base,
      changed: ['src/legacy.txt'],
    });
    expect(ran.checks.find(check => check.checkId === 'APOS-REFACTOR-SCOPE')).toMatchObject({ status: 'pass' });
  }, 120_000);

  it('is red for a characterize Goal whose integration commit changed code in any commit since the lock', async () => {
    const p = await testingProject({ goal: characterize, files });
    const lock = p.commit(
      {
        'tests/acceptance/calc.t': 'case total pass\n',
        [`.apos/goals/${p.goalId}/tests.json`]: mapFor(p.goalId, ['tests.acceptance.calc::total']),
      },
      'capture',
    );
    p.commit({ 'src/legacy.txt': 'tampered\n' }, 'edit the code');
    const head = p.commit({ 'src/legacy.txt': 'legacy\n' }, 'put it back');
    const ran = service(p).layerChecks(p.state(), {
      stage: 'integrate',
      scope: p.goalId,
      head,
      base: lock,
      changed: [],
    });
    const check = ran.checks.find(item => item.checkId === 'APOS-CHARACTERIZE');
    expect(check).toMatchObject({ status: 'fail' });
    expect(check?.reason).toContain('src/legacy.txt');
  }, 120_000);

  it('adds nothing for an ordinary Goal', async () => {
    const p = await testingProject({ files });
    const ran = service(p).layerChecks(p.state(), {
      stage: 'integrate',
      scope: p.goalId,
      head: p.base,
      base: p.base,
      changed: [],
    });
    expect(ran.checks.some(check => /^APOS-(REFACTOR-SCOPE|CHARACTERIZE)/.test(check.checkId))).toBe(false);
  }, 120_000);
});
