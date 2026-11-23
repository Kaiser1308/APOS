import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RUNNER, setupDocument } from '../app/test-lock.test-support.js';
import { baseFiles, removalGoal } from '../app/removal.test-support.js';
import { sourceText } from '../domain/fixtures.test-support.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { project } from './bug.test-support.js';

/** A repo with the fake test tool, an approved setup, the old coupon tests and a drafted Goal that removes them. */
export async function removalCli(removesTests?: string[], options: { setup?: boolean } = {}) {
  const p = await project();
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(p.dir, file)), { recursive: true });
    writeFileSync(join(p.dir, file), text);
  };
  put('runner.js', RUNNER);
  put('.apos/project.yaml', jsonCodec.stringify(setupDocument));
  put('tests/infra.cfg', 'plain\n');
  put('tests/acceptance/smoke.t', 'case smoke pass\n');
  put('tests/unit/u.t', 'case one pass\n');
  for (const [file, text] of Object.entries(baseFiles)) put(file, text);
  p.git('add', '-A');
  p.git('commit', '-qm', 'setup');
  const commit = p.git('rev-parse', 'HEAD');
  if (options.setup !== false) {
    await p.invoke('setup', 'probe', '--commit', commit);
    await p.invoke('setup', 'approve', '--commit', commit, '--on-behalf', 'test');
  }
  const goal = removalGoal(removesTests);
  put('brief.md', sourceText);
  put('goal.json', JSON.stringify({ ...goal, source: undefined }));
  p.git('add', '-A');
  p.git('commit', '-qm', 'brief');
  await p.invoke('goal', 'create', '--file', join(p.dir, 'goal.json'), '--source', join(p.dir, 'brief.md'));
  p.out.length = 0;
  const approve = (...extra: string[]) =>
    p.invoke(
      'goal',
      'approve',
      goal.id,
      '--size',
      'S',
      '--max-minutes',
      '60',
      '--max-attempts',
      '3',
      '--on-behalf',
      'test',
      ...extra,
    );
  return { ...p, goalId: goal.id, approve, head: () => p.git('rev-parse', 'HEAD') };
}
