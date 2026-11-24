import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { project } from './bug.test-support.js';

export { bugArgs, removeTemp, temp } from './bug.test-support.js';

type Project = Awaited<ReturnType<typeof project>>;

/** A project with an approved setup and a hotfix commit on top of an ordinary one: `base` is "before", `hotfix` fixes it. */
export async function hotfixProject(options: { parts?: string[]; withSetup?: boolean } = {}) {
  const p = await project({ withSetup: true, ...options });
  mkdirSync(join(p.dir, 'src'), { recursive: true });
  writeFileSync(join(p.dir, 'src', 'orders.js'), 'exports.total = (a, b) => a + b; // bug\n');
  p.git('add', '-A');
  p.git('commit', '-qm', 'orders');
  const before = p.git('rev-parse', 'HEAD');
  writeFileSync(join(p.dir, 'src', 'orders.js'), 'exports.total = (a, b) => a - b; // fixed\n');
  p.git('add', '-A');
  p.git('commit', '-qm', 'hotfix: the total');
  const hotfix = p.git('rev-parse', 'HEAD');
  return { ...p, before, hotfix };
}
export type HotfixProject = Awaited<ReturnType<typeof hotfixProject>>;
export type { Project };

export const hotfixArgs = [
  '--given',
  'a cart of 40 and FREE0',
  '--when',
  'the total is computed',
  '--then',
  'the total is 40',
];

/**
 * A repo with the fake test tool of the lock tests: `src/impl.txt` is empty on `before` (the bug) and says `total` on the
 * hotfix (the fix), so a `needs total` test is red on one and green on the other. The setup is approved.
 */
export async function evidenceProject() {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { RUNNER, setupDocument } = await import('../app/test-lock.test-support.js');
  const { jsonCodec } = await import('../domain/setup-codec.js');
  const { project } = await import('./bug.test-support.js');
  const p = await project();
  const put = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(p.dir, file)), { recursive: true });
      writeFileSync(join(p.dir, file), text);
    }
  };
  const commit = (files: Record<string, string>, message: string) => {
    put(files);
    p.git('add', '-A');
    p.git('commit', '-qm', message);
    return p.git('rev-parse', 'HEAD');
  };
  const setup = commit(
    {
      'runner.js': RUNNER,
      '.apos/project.yaml': jsonCodec.stringify(setupDocument),
      'tests/infra.cfg': 'plain\n',
      'tests/unit/u.t': 'case one pass\n',
      'tests/acceptance/smoke.t': 'case smoke pass\n',
      'src/impl.txt': '',
    },
    'setup',
  );
  await p.invoke('setup', 'probe', '--commit', setup);
  await p.invoke('setup', 'approve', '--commit', setup, '--on-behalf', 'test');
  const before = setup;
  const hotfix = commit({ 'src/impl.txt': 'total\n' }, 'hotfix: the total');
  const goalId = 'GOAL-BUG-001';
  const mapPath = `.apos/goals/${goalId}/tests.json`;
  const map = JSON.stringify([
    { acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['tests.acceptance.calc::total'] },
  ]);
  /** A Tester commit on `before`, as the bugfix rule wants it: tests and tests.json, nothing else. */
  const tests = (kind: 'pass' | 'needs total') => {
    p.git('checkout', '-q', '--detach', before);
    return commit({ 'tests/acceptance/calc.t': `case total ${kind}\n`, [mapPath]: map }, `tests: ${kind}`);
  };
  const accept = (...extra: string[]) =>
    p.invoke('hotfix', 'the total is wrong', '--commit', hotfix, ...hotfixArgs, '--on-behalf', 'demo', ...extra);
  return { ...p, before, hotfix, goalId, tests, accept, commit, put };
}
