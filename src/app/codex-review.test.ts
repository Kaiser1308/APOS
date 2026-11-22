import { afterEach, describe, expect, it } from 'vitest';
import { PackageService } from './package-service.js';
import { cleanProjects, lockedProject, testingProject, ids } from './test-lock.test-support.js';
import { spec } from '../domain/fixtures.test-support.js';
import { parseGoalSpec } from '../domain/contracts.js';

afterEach(cleanProjects);

describe('a test the tester did not change is still locked (Codex, PR #40)', () => {
  const goal = parseGoalSpec({
    ...spec,
    checks: [{ ...spec.checks[0]!, command: 'node -e "process.exit(0)"' }],
    acceptance: [spec.acceptance[0], { ...spec.acceptance[0], id: 'AC-2', proof: 'stays-green' }],
  });
  const keep = 'tests.acceptance.keep::keep';

  it('hashes the file of a stays-green test that already existed, so weakening it is red', async () => {
    const p = await testingProject({
      goal,
      files: { 'tests/acceptance/keep.t': 'case keep pass\ncase extra pass\n' },
      paths: ['src/**', 'tests/**'],
    });
    const commit = p.commit(
      {
        'tests/acceptance/calc.t': 'case add needs add\n',
        'src/stub.txt': 's\n',
        [`.apos/goals/${p.goalId}/tests.json`]: JSON.stringify([
          { acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [ids.add] },
          { acceptanceId: 'AC-2', part: 'app', layer: 'L2', testIds: [keep] },
        ]),
      },
      'tests',
    );
    const locked = await p.service.submit(p.goalId, commit, 'tester');
    expect(locked.problems).toEqual([]);
    expect(Object.keys(p.state().testLock!.files).sort()).toEqual([
      'tests/acceptance/calc.t',
      'tests/acceptance/keep.t',
    ]);
    expect(p.state().testLock!.asserts['tests/acceptance/keep.t']).toBe(2);
  }, 90_000);
});

describe('a dependent package is not charged for its dependency (Codex, PR #40)', () => {
  const dependent = async () => {
    const p = await lockedProject({ paths: ['src/**'] });
    p.git('checkout', '-q', '-b', 'a', p.lockCommit);
    const a = p.commit({ 'src/a.txt': 'a\n' }, 'WP-A');
    const b = p.commit({ 'src/b.txt': 'b\n' }, 'WP-B');
    const state = p.state();
    const wp = (id: string, dependencies: string[], paths: string[]) => ({
      ...state.packages!['WP-MAIN']!.spec,
      id,
      dependencies,
      paths,
    });
    const packages = {
      'WP-A': {
        spec: wp('WP-A', [], ['src/a.txt']),
        status: 'green' as const,
        attempts: 0,
        gate: { deliveryCommit: a },
      },
      'WP-B': { spec: wp('WP-B', ['WP-A'], ['src/b.txt']), status: 'pending' as const, attempts: 0 },
    };
    // The state the gate sees, with the two packages WP-MAIN stands in for.
    const seen = { ...state, packages } as unknown as Parameters<typeof p.assurance.checks>[0];
    const scope = (head: string) =>
      p.assurance
        .checks(
          seen,
          packages['WP-B'] as unknown as Parameters<typeof p.assurance.checks>[1],
          head,
          p.lockCommit,
          p.git('diff', '--name-only', p.lockCommit, head).split('\n').filter(Boolean),
        )
        .find(check => check.checkId === 'APOS-SCOPE')!;
    return { p, a, b, scope };
  };

  it('passes when the dependency files are as the dependency left them', async () => {
    const { b, scope } = await dependent();
    expect(scope(b).status).toBe('pass');
  }, 120_000);

  it('is red when the dependent package changes a file its dependency brought', async () => {
    const { p, scope } = await dependent();
    const changed = p.commit({ 'src/a.txt': 'tampered\n' }, 'touch WP-A file');
    const check = scope(changed);
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('src/a.txt');
  }, 120_000);
});

describe('a pinned Goal scopes every package (Codex, PR #40)', () => {
  it('refuses a package added or revised without paths', async () => {
    const p = await testingProject();
    const service = new PackageService(p.journal);
    const bare = {
      id: 'WP-X',
      goalId: p.goalId,
      goalVersion: 1,
      version: 1,
      owner: 'w',
      outcome: 'o',
      scope: ['s'],
      exclusions: [],
      dependencies: [],
      interfaces: ['i@v1'],
      acceptance: [{ id: 'AC-X', text: 't', goalAcceptanceId: 'AC-1' }],
      integration: 'i',
    };
    expect(() => service.add(p.goalId, bare, 'why')).toThrow(/WP-X has no paths/);
    expect(() => service.revise(p.goalId, bare, 'why')).toThrow(/WP-X has no paths/);
  }, 60_000);
});
