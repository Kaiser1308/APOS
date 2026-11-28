import { afterEach, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { cleanProjects, lockedProject } from '../app/test-lock.test-support.js';
import { ReviewBlockService } from '../app/review-block.js';
import { IntegrationService } from '../app/integration.js';
import { ExceptionService } from '../app/exceptions.js';
import { ProjectJournal } from '../store/journal.js';
import { spec } from '../domain/fixtures.test-support.js';

afterEach(() => {
  process.exitCode = undefined;
  cleanProjects();
});

async function reviewed(scope: 'package' | 'integration', overridden = false, tampered = true) {
  const pkg = {
    id: 'WP-A',
    goalId: spec.id,
    goalVersion: 1,
    version: 1,
    owner: 'worker',
    outcome: 'implement',
    scope: ['implementation'],
    exclusions: [],
    dependencies: [],
    interfaces: ['api@v1'],
    acceptance: [{ id: 'WP-AC-1', text: 'works', goalAcceptanceId: 'AC-1' }],
    integration: 'integrate',
    paths: ['src/**'],
    stubPaths: ['src/stub.txt'],
  };
  const p = await lockedProject(
    scope === 'integration'
      ? {
          plan: { mode: 'multi-wp' },
          packages: [
            pkg,
            {
              ...pkg,
              id: 'WP-B',
              outcome: 'extra',
              dependencies: ['WP-A'],
              acceptance: [{ id: 'WP-AC-2', text: 'done' }],
            },
          ],
        }
      : {},
  );
  p.git('checkout', '-qb', 'worker');
  const first = p.commit({ 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' }, 'implement');
  expect((await p.submit(first, scope === 'package' ? 'WP-MAIN' : 'WP-A')).result).toBe('green');
  if (scope === 'integration') {
    const second = p.commit({ 'src/extra.txt': 'extra\n' }, 'second package');
    expect((await p.submit(second, 'WP-B')).result).toBe('green');
    expect(p.gate.run(p.goalId, p.dir, { deliveryCommit: second }).result).toBe('green');
    new IntegrationService(p.journal).complete(p.goalId, p.dir, {
      commitRef: second,
      conflictResolution: 'dependency is included',
    });
  }
  p.git('checkout', '-qb', 'review', p.state().verifiedCommit!);
  const reviewCommit = p.commit({ 'tests/unit/review.t': 'case review needs fixed\n' }, 'reviewer test');
  const service = new ReviewBlockService(p.journal, {
    repoPath: p.dir,
    runner: p.runner,
    loadSetup: state => p.loadSetup(state),
  });
  expect(
    (await service.block(p.goalId, scope === 'package' ? 'WP-MAIN' : undefined, reviewCommit, 'reviewer')).outcome,
  ).toBe('blocked');
  if (overridden)
    new ExceptionService(p.journal).approve(p.goalId, {
      kind: 'review-overridden',
      ref: `${scope === 'package' ? 'WP-MAIN' : p.goalId}:${reviewCommit}`,
      reason: 'fixture waiver',
      by: 'agent:lead',
    });
  if (scope === 'integration') {
    p.git('checkout', '-q', 'worker');
    p.git('merge', '-q', '--no-edit', 'review');
  }
  p.git('restore', '--source', 'HEAD', '--worktree', '--', '.apos/goals');
  const fixed = p.commit(
    { 'src/impl.txt': 'add fixed\n', ...(overridden ? { 'tests/unit/review.t': 'case review pass\n' } : {}) },
    'fix',
  );
  if (scope === 'package') expect((await p.submit(fixed)).result).toBe('green');
  else {
    const report = p.gate.run(p.goalId, p.dir, { deliveryCommit: fixed });
    expect(report.result, JSON.stringify(report.checks)).toBe('green');
    new IntegrationService(p.journal).complete(p.goalId, p.dir, {
      commitRef: fixed,
      conflictResolution: 'dependency is included',
    });
  }
  p.close();
  p.git('checkout', '-q', 'main');
  p.git('merge', '--ff-only', overridden ? fixed : reviewCommit);
  p.commit(
    tampered
      ? { 'tests/unit/review.t': overridden ? 'case review pass\ncase target pass\n' : 'case review pass\n' }
      : { 'other.txt': 'independent change\n' },
    'target change',
  );
  return p;
}

it.each(['package', 'integration'] as const)(
  'refuses merge when target weakens the %s review test',
  async scope => {
    const p = await reviewed(scope);
    const out: string[] = [];
    await runCli(
      ['--repo', p.dir, 'outcome', 'close', p.goalId, '--merge-to', 'main', '--on-behalf', 'fixture', '--json'],
      {
        home: p.home,
        gate: { artifactRoot: p.artifacts },
        write: text => out.push(text),
        io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
      },
    );
    const opened = ProjectJournal.open(p.dir, p.home);
    try {
      const state = opened.journal.getGoal(p.goalId)!;
      expect(state.status).toBe('verified');
      expect(state.postMergeGate).toMatchObject({ result: 'red', deliveryCommit: state.merge!.mergeCommit });
      expect(state.postMergeGate!.checks).toContainEqual(
        expect.objectContaining({ checkId: 'APOS-REVIEW', status: 'fail' }),
      );
    } finally {
      opened.close();
    }
  },
  240_000,
);

it.each(['package', 'integration'] as const)(
  'honors a valid %s review override on the merge result',
  async scope => {
    const p = await reviewed(scope, true);
    await runCli(['--repo', p.dir, 'outcome', 'close', p.goalId, '--merge-to', 'main', '--on-behalf', 'fixture'], {
      home: p.home,
      gate: { artifactRoot: p.artifacts },
      write: () => {},
      io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
    });
    const opened = ProjectJournal.open(p.dir, p.home);
    try {
      const state = opened.journal.getGoal(p.goalId)!;
      expect(state.status).toBe('closed');
      expect(state.postMergeGate).toMatchObject({ result: 'green', deliveryCommit: state.merge!.mergeCommit });
      expect(state.postMergeGate!.checks).toContainEqual(
        expect.objectContaining({
          checkId: 'APOS-REVIEW',
          status: 'pass',
          reason: expect.stringContaining('review bị bỏ qua'),
        }),
      );
    } finally {
      opened.close();
    }
  },
  240_000,
);

it('closes when a non-waived review is unchanged on the merge', async () => {
  const p = await reviewed('package', false, false);
  await runCli(['--repo', p.dir, 'outcome', 'close', p.goalId, '--merge-to', 'main', '--on-behalf', 'fixture'], {
    home: p.home,
    gate: { artifactRoot: p.artifacts },
    write: () => {},
    io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
  });
  const opened = ProjectJournal.open(p.dir, p.home);
  try {
    const state = opened.journal.getGoal(p.goalId)!;
    expect(state.status).toBe('closed');
    expect(state.postMergeGate!.checks).toContainEqual(
      expect.objectContaining({ checkId: 'APOS-REVIEW', status: 'pass' }),
    );
  } finally {
    opened.close();
  }
}, 240_000);
