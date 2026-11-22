import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceText, spec } from '../domain/fixtures.test-support.js';
import { hasPytest, hasVitest, openProject, python, typescript, type Stack } from './layers-scenario.test-support.js';

/**
 * Phase 4 through the CLI with a real runner: the Lead adds a layer and an agent cuts a floor layer; a trigger on a
 * changed file pulls the e2e layer into submit; a benchmark and a scan criterion (the Goal's thresholds) fail, then pass;
 * the close stage runs every layer of the floor; `goal show` prints the assurance table.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const criterion = (id: string, extra: object) => ({
  ...spec.acceptance[0]!,
  id,
  text: id,
  checkIds: [] as string[],
  ...extra,
});

async function solo(stack: Stack) {
  const p = openProject(stack, dirs);
  const base = await p.setUp();
  const goal = {
    ...spec,
    flags: ['perf'],
    checks: [{ ...spec.checks[0]!, command: stack.check }],
    acceptance: [
      spec.acceptance[0],
      criterion('AC-2', {
        proof: 'benchmark',
        benchmark: { tool: 'app.L5.bench', metric: 'p95_ms', op: '<', value: 200 },
      }),
      criterion('AC-3', { proof: 'scan', scan: { tool: 'app.L5.scan', failOn: 'warning' } }),
    ],
  };
  writeFileSync(join(p.dir, 'brief.md'), sourceText);
  const goalFile = p.json('goal.plan.json', goal);
  await p.invoke('goal', 'create', '--file', goalFile, '--source', join(p.dir, 'brief.md'));
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
    ...p.human,
  );
  expect(approved.code ?? 0).toBe(0);
  await p.invoke('goal', 'select', spec.id, ...p.human);
  return { p, base, stack };
}

describe.each([
  ['python', python, hasPytest],
  ['typescript', typescript, hasVitest],
])('layers flow, %s', (label, stack, available) => {
  it.skipIf(!available)(
    `${stack.name}: Lead's layer, floor cut by an agent, trigger, benchmark and scan, close stage, assurance table`,
    async () => {
      const { p, base } = await solo(stack);
      const a = stack.modules.a;
      const plan = (version: number, layers: object) =>
        p.json('plan.plan.json', {
          id: 'EXEC-001',
          version,
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
          layers,
          acceptanceMapping: [
            { acceptanceId: 'AC-1', verification: 'acceptance test' },
            { acceptanceId: 'AC-2', verification: 'benchmark at submit' },
            { acceptanceId: 'AC-3', verification: 'scan at submit' },
          ],
          verificationStrategy: 'locked acceptance test, benchmark, scan',
        });

      // The Lead may add only what the setup has: L6 is a manual check, not a layer a tool runs.
      await p.invoke('lead', 'propose', '--file', plan(1, { submit: ['L6'] }));
      const refused = await p.invoke('lead', 'commit', spec.id);
      expect(refused.code).toBe(1);
      expect(refused.text).toContain('WP-MAIN adds L6 at submit: L6 is a manual check of the Goal');
      await p.invoke('lead', 'propose', '--file', plan(2, { submit: ['L3', 'L5'] }));
      expect((await p.invoke('lead', 'commit', spec.id)).code ?? 0).toBe(0);
      expect(p.state(spec.id).status).toBe('testing');

      // The tester: one acceptance test, red because the stub is not implemented.
      const mapPath = `.apos/goals/${spec.id}/tests.json`;
      const map = JSON.stringify([{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [a.testId] }]);
      const locked = p.commit({ [a.stub]: a.red, [a.test]: a.testSource, [mapPath]: map }, 'tests and stub');
      const lock = await p.invoke('tests', 'submit', spec.id, '--commit', locked);
      expect(lock.code ?? 0).toBe(0);
      expect(p.state(spec.id).status).toBe('executing');

      // An agent approves cutting the acceptance layer from this package's submit: its tests are still judged by APOS-LOCKED.
      const cut = await p.invoke(
        'exception',
        'approve',
        spec.id,
        '--kind',
        'floor-reduced',
        '--ref',
        'WP-MAIN:submit:L2',
        '--reason',
        'the locked tests are judged by APOS-LOCKED already',
        '--by',
        'agent:lead',
      );
      expect(cut.code ?? 0).toBe(0);

      const worker = (name: string, files: Record<string, string>) => {
        p.git('checkout', '-q', '-B', name, locked);
        return p.commit(files, name);
      };
      const page = { [stack.ui]: '// the page\n' };

      // Too slow and a blocking finding: red, and each reason is the Goal's own threshold.
      const slow = worker('slow', {
        [a.stub]: a.done,
        ...page,
        'perf/bench.txt': '250\n',
        'perf/findings.txt': 'warning note\n',
      });
      const red = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', slow);
      expect(red.code).toBe(1);
      expect(red.text).toContain('app.L5.bench fail');
      expect(red.text).toContain('p95_ms < 200 does not hold: measured 250, 250, 250');
      expect(red.text).toContain('app.L5.scan fail');
      expect(red.text).toContain('1 finding(s) at warning or above, 1 below');
      const first = p.state(spec.id).packages?.['WP-MAIN']?.gate;
      expect(first?.layers?.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ layer: 'L2', reduced: true }),
          expect.objectContaining({ part: 'system', layer: 'L4', why: 'trigger' }),
          expect.objectContaining({ layer: 'L3', why: 'lead' }),
        ]),
      );

      // Fast enough, and the only finding is below the level the Goal blocks on: green, and the count is kept.
      const fast = worker('fast', {
        [a.stub]: a.done,
        ...page,
        'perf/bench.txt': '150\n',
        'perf/findings.txt': 'note\n',
      });
      const green = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', fast);
      expect(green.text).toContain(`WP-MAIN green on ${fast}; ${spec.id} verified`);
      expect(green.code).toBe(0);
      const gate = p.state(spec.id).packages?.['WP-MAIN']?.gate;
      expect(gate?.checks.find(check => check.checkId === 'app.L5.bench')).toMatchObject({
        status: 'pass',
        metric: { name: 'p95_ms', value: 150 },
      });
      expect(gate?.checks.find(check => check.checkId === 'app.L5.scan')).toMatchObject({
        status: 'pass',
        findings: { blocking: 0, lower: 1 },
      });
      expect(gate?.checks.some(check => check.checkId.startsWith('app.L2.'))).toBe(false);

      // Closing runs the close-stage floor on the verified commit.
      const closed = await p.invoke('outcome', 'close', spec.id, ...p.human);
      expect(closed.text).toContain(`Close-stage layers green on ${fast}`);
      expect(p.state(spec.id).status).toBe('closed');
      const close = p.state(spec.id).closeGate;
      expect(close?.layers?.runs.map(run => `${run.part}.${run.layer}`)).toEqual([
        'app.L1',
        'app.L2',
        'app.L3',
        'system.L4',
        'app.L5',
        'app.L5',
      ]);

      const shown = await p.invoke('goal', 'show', spec.id);
      await expect(
        shown.text.replace(/\r\n/g, '\n').replaceAll(fast, '<commit>').replaceAll(locked, '<commit>'),
      ).toMatchFileSnapshot(`./__snapshots__/layers-solo-${label}.txt`);
    },
    900_000,
  );
});
