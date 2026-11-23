import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceText, spec } from '../domain/fixtures.test-support.js';
import { hasPytest, hasVitest, openProject, python, typescript } from './layers-scenario.test-support.js';

/**
 * Review focus 5: the integration gate of a Multi-WP Goal runs the layers of the integrate stage on the integration
 * commit. Two packages, each green on its own locked test; an integration commit that breaks the L3 test is red
 * and names the layer; the fixed commit is green, completes, and closes with the close-stage layers.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe.each([
  ['python', python, hasPytest],
  ['typescript', typescript, hasVitest],
])('layers flow, Multi-WP, %s', (label, stack, available) => {
  it.skipIf(!available)(
    `${stack.name}: two packages, an integration gate that runs L3 and names it when it breaks, then close`,
    async () => {
      const p = openProject(stack, dirs);
      const base = await p.setUp();
      const { a, b } = stack.modules;
      const second = { ...spec.acceptance[0]!, id: 'AC-2', text: 'AC-2' };
      const check = (id: string, command: string) => ({ ...spec.checks[0]!, id, command });
      const goal = {
        ...spec,
        checks: [check('CHK-A', a.check), check('CHK-B', b.check)],
        acceptance: [
          { ...spec.acceptance[0]!, checkIds: ['CHK-A'] },
          { ...second, checkIds: ['CHK-B'] },
        ],
      };
      writeFileSync(join(p.dir, 'brief.md'), sourceText);
      await p.invoke('goal', 'create', '--file', p.json('goal.plan.json', goal), '--source', join(p.dir, 'brief.md'));
      await p.invoke(
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
      await p.invoke('goal', 'select', spec.id, ...p.human);

      const wp = (
        id: string,
        owner: string,
        criterion: string,
        checkId: string,
        module: typeof a,
        extra: object = {},
      ) => ({
        id,
        goalId: spec.id,
        goalVersion: 1,
        version: 1,
        owner,
        outcome: `${id} done`,
        scope: [id],
        exclusions: [],
        dependencies: [],
        interfaces: [`${id}-api@v1`],
        acceptance: [{ id: `${id}-AC`, text: 'works', goalAcceptanceId: criterion, checkIds: [checkId] }],
        integration: 'the Lead merges the two branches',
        paths: [module.stub],
        stubPaths: [module.stub],
        ...extra,
      });
      await p.invoke(
        'lead',
        'propose',
        '--file',
        p.json('plan.plan.json', {
          id: 'EXEC-001',
          version: 1,
          goalId: spec.id,
          goalVersion: 1,
          mode: 'multi-wp',
          approach: 'two modules',
          rationale: 'two modules, two owners',
          splitRationale: 'the modules share nothing',
          estimatedCost: { wallMinutes: 90 },
          risks: [],
          baseCommit: base,
          entries: ['add', 'sub'],
          acceptanceMapping: [
            { acceptanceId: 'AC-1', verification: 'acceptance test' },
            { acceptanceId: 'AC-2', verification: 'acceptance test' },
          ],
          verificationStrategy: 'locked acceptance tests, then the integration layer',
        }),
      );
      for (const item of [
        wp('WP-A', 'dev-a', 'AC-1', 'CHK-A', a),
        wp('WP-B', 'dev-b', 'AC-2', 'CHK-B', b, { layers: { submit: ['L3'] } }),
      ])
        await p.invoke('package', 'add', '--file', p.json(`${item.id}.plan.json`, item), '--reason', 'split');
      expect((await p.invoke('lead', 'commit', spec.id)).code ?? 0).toBe(0);
      expect(p.state(spec.id).status).toBe('testing');

      const map = JSON.stringify([
        { acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [a.testId] },
        { acceptanceId: 'AC-2', part: 'app', layer: 'L2', testIds: [b.testId] },
      ]);
      const locked = p.commit(
        {
          [a.stub]: a.red,
          [b.stub]: b.red,
          [a.test]: a.testSource,
          [b.test]: b.testSource,
          [`.apos/goals/${spec.id}/tests.json`]: map,
        },
        'tests and stubs',
      );
      expect((await p.invoke('tests', 'submit', spec.id, '--commit', locked)).code ?? 0).toBe(0);

      // Each package is green on its own: its criteria's locked tests pass, the other package's are not its business yet.
      p.git('checkout', '-q', '-B', 'wp-a', locked);
      const doneA = p.commit({ [a.stub]: a.done }, 'a');
      p.git('checkout', '-q', '-B', 'wp-b', locked);
      const doneB = p.commit({ [b.stub]: b.done }, 'b');
      const gotA = await p.invoke('package', 'submit', spec.id, 'WP-A', '--commit', doneA);
      expect(gotA.text).toContain(`WP-A green on ${doneA}`);
      const gotB = await p.invoke('package', 'submit', spec.id, 'WP-B', '--commit', doneB);
      expect(gotB.text).toContain(`WP-B green on ${doneB}`);
      expect(p.state(spec.id).packages?.['WP-B']?.gate?.layers?.runs).toEqual(
        expect.arrayContaining([expect.objectContaining({ layer: 'L3', why: 'lead' })]),
      );
      expect(p.state(spec.id).status).toBe('executing');

      // The integration commit merges both and breaks the integration test.
      p.git('checkout', '-q', '-B', 'integration', 'wp-a');
      p.git('merge', '-q', '--no-edit', 'wp-b');
      const broken = p.commit({ [stack.breakFlag]: 'x\n' }, 'integration breaks flow');
      const red = await p.invoke(
        'integration',
        'gate',
        spec.id,
        '--commit',
        broken,
        '--reason',
        'merge of WP-A and WP-B',
      );
      expect(red.text).toContain(`Integration gate red on ${broken}`);
      expect(red.text).toMatch(/app\.L3\.\S+ fail: app\.L3 \S+: 1 new failure\(s\) vs the base/);
      const gate = p.state(spec.id).gate;
      expect(gate?.layers?.stage).toBe('integrate');
      expect(gate?.layers?.runs.map(run => `${run.part}.${run.layer}`)).toEqual(['app.L1', 'app.L2', 'app.L3']);
      const failed = gate?.checks.filter(check => check.checkId.startsWith('app.L3.') && check.status === 'fail');
      expect(failed).toHaveLength(1);
      expect(failed?.[0]?.reason).toMatch(/app\.L3 .*: 1 new failure\(s\) vs the base/);
      expect(gate?.checks.find(check => check.checkId.startsWith('app.L2.'))?.status).toBe('pass');
      const refused = await p.invoke('integration', 'complete', spec.id, '--commit', broken);
      expect(refused.code).toBe(1);
      expect(p.state(spec.id).status).toBe('executing');

      // Fixed: both locked tests now pass at the integrate stage, and the Goal verifies on this commit.
      const fixed = p.commit({ [stack.breakFlag]: null }, 'integration fixed');
      const done = await p.invoke('integration', 'gate', spec.id, '--commit', fixed, '--reason', 'fixed the break');
      expect(done.text).toContain(`Integration gate green on ${fixed}`);
      expect((await p.invoke('integration', 'complete', spec.id, '--commit', fixed)).code ?? 0).toBe(0);
      expect(p.state(spec.id)).toMatchObject({ status: 'verified', verifiedCommit: fixed });

      // A reviewer blocks the integration commit with a red test. Gating the same commit again does not slip past the
      // block: the reviewer's test is locked into the next integration commit, and only an exception waives it.
      p.git('checkout', '-q', '-B', 'integration-review', fixed);
      const reviewed = p.commit(
        { [stack.integrationReview.file]: stack.integrationReview.red },
        'review of the integration',
      );
      const blocked = await p.invoke(
        'review',
        'block',
        spec.id,
        '--integration',
        '--commit',
        reviewed,
        '--by',
        'reviewer',
      );
      expect(blocked.text).toContain('blocked by review');
      expect(blocked.code).toBe(1);
      expect(p.state(spec.id).status).toBe('executing');
      // The next integration commit leaves the reviewer's test out: red, and the check names the file.
      // APOS rewrote its Goal documents when it recorded the block: they are not part of the integration commit.
      // The integration branch also carries the milestone commit APOS made when the Goal was verified: merge the review into it.
      p.git('checkout', '-q', 'integration');
      p.git('merge', '-q', '--no-edit', 'integration-review');
      const dropped = p.commit({ [stack.integrationReview.file]: null }, 'drop the review test');
      const again = await p.invoke(
        'integration',
        'gate',
        spec.id,
        '--commit',
        dropped,
        '--reason',
        'without the review',
      );
      expect(again.text).toContain(`Integration gate red on ${dropped}`);
      expect(again.text).toContain(`review test modified: ${stack.integrationReview.file}`);
      expect((await p.invoke('integration', 'complete', spec.id, '--commit', dropped)).code).toBe(1);
      const waive = await p.invoke(
        'exception',
        'approve',
        spec.id,
        '--kind',
        'review-overridden',
        '--ref',
        `${spec.id}:${reviewed}`,
        '--reason',
        'a defect that was there before the Goal',
        '--by',
        'agent:lead',
      );
      expect(waive.code ?? 0).toBe(0);
      const waived = await p.invoke('integration', 'gate', spec.id, '--commit', dropped, '--reason', 'review waived');
      expect(waived.text).toContain(`Integration gate green on ${dropped}`);
      expect((await p.invoke('integration', 'complete', spec.id, '--commit', dropped)).code ?? 0).toBe(0);
      expect(p.state(spec.id)).toMatchObject({ status: 'verified', verifiedCommit: dropped });

      const closed = await p.invoke('outcome', 'close', spec.id, ...p.human);
      expect(closed.text).toContain(`Close-stage layers green on ${dropped}`);
      expect(p.state(spec.id).status).toBe('closed');

      const shown = await p.invoke('goal', 'show', spec.id);
      await expect(
        shown.text
          .replace(/\r\n/g, '\n')
          .trimEnd()
          .replaceAll(dropped, '<commit>')
          .replaceAll(reviewed, '<review>')
          .replaceAll(locked, '<commit>'),
      ).toMatchFileSnapshot(`./__snapshots__/layers-multi-${label}.txt`);
    },
    900_000,
  );
});
