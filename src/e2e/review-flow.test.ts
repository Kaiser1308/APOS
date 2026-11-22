import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceText, spec } from '../domain/fixtures.test-support.js';
import { hasPytest, hasVitest, openProject, python, typescript, type Stack } from './layers-scenario.test-support.js';

/**
 * A review blocks only with a test, through the CLI and a real runner. A delivery passes its locked acceptance test but
 * adds `abs`: a reviewer commits a test of negative numbers on top of it, `review block` runs it and puts the package back
 * to red, the next delivery has to contain it and pass it, and a refused or overridden review is judged by the same rules.
 */
const dirs: string[] = [];
afterEach(() => {
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** The reviewer's tests per stack: red on the buggy delivery, green on a correct one. */
const review = {
  python: {
    negative: {
      'tests/test_adder_review.py': 'from adder import add\n\n\ndef test_negative():\n    assert add(-1, -2) == -3\n',
    },
    green: { 'tests/test_adder_more.py': 'from adder import add\n\n\ndef test_zero():\n    assert add(0, 0) == 0\n' },
    broken: { 'tests/test_adder_broken.py': 'import no_such_module_anywhere\n\n\ndef test_x():\n    assert True\n' },
    other: { 'adder_extra.py': 'X = 1\n' },
    bad: 'def add(a, b):\n    return abs(a) + abs(b)\n',
  },
  typescript: {
    negative: {
      'src/adder.review.test.ts':
        "import { it, expect } from 'vitest';\nimport { add } from './adder.js';\nit('adds negatives', () => expect(add(-1, -2)).toBe(-3));\n",
    },
    green: {
      'src/adder.more.test.ts':
        "import { it, expect } from 'vitest';\nimport { add } from './adder.js';\nit('adds zero', () => expect(add(0, 0)).toBe(0));\n",
    },
    broken: {
      'src/adder.broken.test.ts':
        "import { it, expect } from 'vitest';\nimport { nothing } from './no-such-module-anywhere.js';\nit('x', () => expect(nothing).toBe(1));\n",
    },
    other: { 'src/adder-extra.ts': 'export const X = 1;\n' },
    bad: 'export const add = (a: number, b: number): number => Math.abs(a) + Math.abs(b);\n',
  },
} as const;

async function delivered(stack: Stack, kind: keyof typeof review) {
  const p = openProject(stack, dirs);
  const base = await p.setUp();
  const a = stack.modules.a;
  writeFileSync(join(p.dir, 'brief.md'), sourceText);
  const goal = { ...spec, checks: [{ ...spec.checks[0]!, command: stack.check }] };
  await p.invoke('goal', 'create', '--file', p.json('goal.plan.json', goal), '--source', join(p.dir, 'brief.md'));
  await p.invoke('goal', 'approve', spec.id, '--size', 'M', '--max-minutes', '240', '--max-attempts', '5', ...p.human);
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
    acceptanceMapping: [{ acceptanceId: 'AC-1', verification: 'acceptance test' }],
    verificationStrategy: 'locked acceptance test',
  });
  await p.invoke('lead', 'propose', '--file', plan);
  await p.invoke('lead', 'commit', spec.id);
  const map = JSON.stringify([{ acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: [a.testId] }]);
  const locked = p.commit(
    { [a.stub]: a.red, [a.test]: a.testSource, [`.apos/goals/${spec.id}/tests.json`]: map },
    'tests and stub',
  );
  expect((await p.invoke('tests', 'submit', spec.id, '--commit', locked)).code ?? 0).toBe(0);
  const from = (name: string, parent: string, files: Record<string, string>) => {
    p.git('checkout', '-q', '-B', name, parent);
    return p.commit(files, name);
  };
  // The delivery passes the locked test and still gets negative numbers wrong.
  const bad = from('bad', locked, { [a.stub]: review[kind].bad });
  const green = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', bad);
  expect(green.text).toContain(`${spec.id} verified`);
  return { p, a, locked, bad, from, kind, base };
}

describe.each([
  ['python', python, hasPytest],
  ['typescript', typescript, hasVitest],
] as const)('review block, %s', (kind, stack, available) => {
  it.skipIf(!available)(
    `${stack.name}: a red test blocks, is locked into the next delivery, and a fix on top of it passes`,
    async () => {
      const { p, a, bad, from } = await delivered(stack, kind);
      const mine = review[kind];
      const tested = from('review', bad, mine.negative);

      const blocked = await p.invoke('review', 'block', spec.id, 'WP-MAIN', '--commit', tested, '--by', 'reviewer');
      expect(blocked.code).toBe(1);
      expect(blocked.text).toContain('blocked by review:');
      const after = p.state(spec.id);
      expect(after.status).toBe('executing');
      expect(after.packages?.['WP-MAIN']).toMatchObject({ status: 'red', attempts: 1 });
      expect(after.packages?.['WP-MAIN']?.finding).toContain('blocked by review');
      // The delivery's adder did not exist before the Goal, so the test was red there too: told, not waived.
      expect(after.packages?.['WP-MAIN']?.finding).toContain('also red before the Goal');
      expect(after.reviewTests?.[0]).toMatchObject({ reviewCommit: tested, deliveryCommit: bad });

      // The delivery that was blocked cannot go through again as it is.
      const again = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', bad);
      expect(again.code).toBe(1);
      expect(again.text).toContain('does not contain the review commit');

      // Built on the review commit, correct, but the reviewer's test was touched: red, and the file is named.
      const [file, text] = Object.entries(mine.negative)[0]!;
      const tampered = from('tampered', tested, { [a.stub]: a.done, [file]: `${text}\n` });
      const red = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', tampered);
      expect(red.code).toBe(1);
      expect(red.text).toContain('APOS-REVIEW fail');
      expect(red.text).toContain(`review test modified: ${file}`);

      // Fixed on top of the review commit: green again, with the reviewer's tests locked in.
      const fixed = from('fixed', tested, { [a.stub]: a.done });
      const ok = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', fixed);
      expect(ok.text).toContain(`${spec.id} verified`);
      expect(ok.code).toBe(0);
      const gate = p.state(spec.id).packages?.['WP-MAIN']?.gate;
      expect(gate?.checks.find(check => check.checkId === 'APOS-REVIEW')).toMatchObject({ status: 'pass' });
    },
    900_000,
  );

  it.skipIf(!available)(
    `${stack.name}: a review may only add tests that load, advice is not a block, an override waives the block`,
    async () => {
      const { p, a, locked, bad, from } = await delivered(stack, kind);
      const mine = review[kind];
      const refuse = async (commit: string, text: string | RegExp) => {
        const said = await p.invoke('review', 'block', spec.id, 'WP-MAIN', '--commit', commit, '--by', 'reviewer');
        expect(said.code).toBe(1);
        expect(said.text).toMatch(text);
        expect(p.state(spec.id).status).toBe('verified');
      };
      // Review Focus 3: not a test file; a test that exists is changed; the parent is not the delivery.
      await refuse(from('r-other', bad, mine.other), /is not a test file/);
      await refuse(
        from('r-edit', bad, { [a.test]: `${a.testSource}\n` }),
        /may only add tests, never change one that exists/,
      );
      await refuse(from('r-parent', locked, mine.negative), /exactly one parent/);
      // Review Focus 1: a test that cannot load proves nothing.
      await refuse(from('r-broken', bad, mine.broken), /did not load/);
      expect(p.state(spec.id).reviewTests).toBeUndefined();

      // Green tests are advice: nothing is blocked.
      const advice = await p.invoke(
        'review',
        'block',
        spec.id,
        'WP-MAIN',
        '--commit',
        from('r-green', bad, mine.green),
        '--by',
        'reviewer',
      );
      expect(advice.code ?? 0).toBe(0);
      expect(advice.text).toContain('advice only');
      expect(p.state(spec.id)).toMatchObject({
        status: 'verified',
        reviews: [expect.objectContaining({ result: 'pass' })],
      });

      // A red test blocks; the Lead overrides the block, and the delivery that was blocked goes through.
      const tested = from('r-red', bad, mine.negative);
      expect((await p.invoke('review', 'block', spec.id, 'WP-MAIN', '--commit', tested, '--by', 'reviewer')).code).toBe(
        1,
      );
      const overridden = await p.invoke(
        'exception',
        'approve',
        spec.id,
        '--kind',
        'review-overridden',
        '--ref',
        `WP-MAIN:${tested}`,
        '--reason',
        'negative numbers are out of scope here',
        '--by',
        'agent:lead',
      );
      expect(overridden.code ?? 0).toBe(0);
      const back = await p.invoke('package', 'submit', spec.id, 'WP-MAIN', '--commit', bad);
      expect(back.code ?? 0).toBe(0);
      const check = p.state(spec.id).packages?.['WP-MAIN']?.gate?.checks.find(item => item.checkId === 'APOS-REVIEW');
      expect(check?.reason).toContain('review bị bỏ qua');
      expect(check?.reason).toContain('duyệt bởi agent:lead');
    },
    900_000,
  );
});
