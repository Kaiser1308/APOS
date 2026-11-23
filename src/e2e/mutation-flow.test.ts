import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceText, spec } from '../domain/fixtures.test-support.js';
import { hasPytest, hasVitest, openProject, python, typescript, type Stack } from './layers-scenario.test-support.js';

/**
 * Mutation through the CLI with a real runner: a Goal approved with `--flag mutation` runs the setup's mutation tool at
 * the close stage on the files it changed (and no test file); the floor is `mutation.minScore` (70), a criterion can raise
 * it; two runs that differ by more than a point prove nothing. The tool is a stand-in that reads its score from a file.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

// scripts/mutate.cjs <report> <changed> <score file>: the score is the file's number, or the next of "a,b" on each run;
// it is 0 unless exactly the one source file the delivery changed was handed over.
const MUTATE =
  "const fs = require('fs');\nconst [report, changed, file, expected] = process.argv.slice(2);\nconst scores = fs.readFileSync(file, 'utf8').trim().split(',').map(Number);\nconst counter = file + '.n';\nconst n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;\nfs.writeFileSync(counter, String(n + 1));\nconst score = changed === expected ? scores[n % scores.length] : 0;\nfs.writeFileSync(report, JSON.stringify({ mutationScore: score }));\n";

async function closeFlow(stack: Stack) {
  const scoreDir = mkdtempSync(join(tmpdir(), 'apos-mutation-'));
  dirs.push(scoreDir);
  const scoreFile = join(scoreDir, 'score.txt').replaceAll('\\', '/');
  const score = (text: string) => {
    writeFileSync(scoreFile, text);
    rmSync(`${scoreFile}.n`, { force: true });
  };
  // The probe runs the tool once, on one source file of the part, so the file has to exist.
  score('0');
  const a = stack.modules.a;
  const withMutation: Stack = { ...stack, files: { ...stack.files, 'scripts/mutate.cjs': MUTATE } };
  const p = openProject(withMutation, dirs);
  const base = await p.setUp(app => {
    app.layers.L5!.push({
      id: 'mutate',
      command: `node scripts/mutate.cjs {report} "{changed}" ${scoreFile} ${a.stub}`,
      format: 'metric',
      metric: 'mutationScore',
      when: 'flag:mutation',
    });
  });
  writeFileSync(join(p.dir, 'brief.md'), sourceText);
  const goal = {
    ...spec,
    checks: [{ ...spec.checks[0]!, command: stack.check }],
    acceptance: [
      spec.acceptance[0],
      {
        ...spec.acceptance[0]!,
        id: 'AC-2',
        text: 'mutation score of the new code is at least 90',
        checkIds: [] as string[],
        proof: 'benchmark',
        benchmark: { tool: 'app.L5.mutate', metric: 'mutationScore', op: '>=', value: 90 },
      },
    ],
  };
  await p.invoke('goal', 'create', '--file', p.json('goal.plan.json', goal), '--source', join(p.dir, 'brief.md'));
  const approved = await p.invoke(
    'goal',
    'approve',
    spec.id,
    '--size',
    'M',
    '--max-minutes',
    '240',
    '--max-attempts',
    '5',
    '--flag',
    'mutation',
    ...p.human,
  );
  expect(approved.text).toContain('with flag mutation');
  await p.invoke('goal', 'select', spec.id, ...p.human);
  const plan = p.json('plan.plan.json', {
    id: 'EXEC-001',
    version: 1,
    goalId: spec.id,
    goalVersion: 1,
    mode: 'solo-direct',
    approach: 'add',
    rationale: 'one owner',
    risks: [],
    baseCommit: base,
    paths: stack.paths,
    stubPaths: [a.stub],
    entries: ['add'],
    acceptanceMapping: [
      { acceptanceId: 'AC-1', verification: 'acceptance test' },
      { acceptanceId: 'AC-2', verification: 'mutation at close' },
    ],
    verificationStrategy: 'locked acceptance test, mutation at close',
  });
  await p.invoke('lead', 'propose', '--file', plan);
  await p.invoke('lead', 'commit', spec.id);
  const map = JSON.stringify([{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [a.testId] }]);
  const locked = p.commit(
    { [a.stub]: a.red, [a.test]: a.testSource, [`.apos/goals/${spec.id}/tests.json`]: map },
    'tests and stub',
  );
  await p.invoke('tests', 'submit', spec.id, '--commit', locked);
  p.git('checkout', '-q', '-B', 'work', locked);
  const done = p.commit({ [a.stub]: a.done }, 'implement');
  const submitted = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', done);
  expect(submitted.text).toContain(`${spec.id} verified`);
  return { p, score };
}

describe.each([
  ['python', python, hasPytest],
  ['typescript', typescript, hasVitest],
] as const)('mutation at close, %s', (_label, stack, available) => {
  it.skipIf(!available)(
    `${stack.name}: the floor, a criterion that raises it, two unstable runs, then green with the score in the table`,
    async () => {
      const { p, score } = await closeFlow(stack);
      const close = () => p.invoke('outcome', 'close', spec.id, ...p.human);

      score('60');
      const low = await close();
      expect(low.code).toBe(1);
      expect(low.text).toContain('mutationScore >= 70 and mutationScore >= 90 does not hold: measured 60, 60');

      // Two runs that differ by more than a point: neither red nor green.
      score('72,80');
      const flaky = await close();
      expect(flaky.code).toBe(1);
      expect(flaky.text).toContain('differs by more than 1 point between two runs');

      // 80 clears the floor of 70, not the 90 the Goal's criterion asks for.
      score('80');
      const raised = await close();
      expect(raised.code).toBe(1);
      expect(raised.text).toContain('mutationScore >= 70 and mutationScore >= 90 does not hold: measured 80, 80');

      score('95');
      const closed = await close();
      expect(closed.code ?? 0).toBe(0);
      expect(p.state(spec.id).status).toBe('closed');
      const shown = await p.invoke('goal', 'show', spec.id);
      expect(shown.text).toContain('mutationScore 95');
    },
    900_000,
  );
});
