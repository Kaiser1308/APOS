import { afterEach, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { cleanProjects, goodTests, testingProject } from '../app/test-lock.test-support.js';

afterEach(() => {
  process.exitCode = undefined;
  cleanProjects();
});

async function cli() {
  const p = await testingProject();
  p.close();
  const out: string[] = [];
  const invoke = async (...args: string[]) => {
    process.exitCode = undefined;
    await runCli(['--repo', p.dir, ...args], {
      home: p.home,
      gate: { artifactRoot: p.artifacts },
      write: line => out.push(line),
    });
    return process.exitCode as number | undefined;
  };
  return { ...p, out, invoke };
}

it('says there is no lock yet while the Goal is testing, and a package cannot be submitted', async () => {
  const p = await cli();
  await p.invoke('goal', 'show', p.goalId);
  expect(p.out).toEqual([
    `${p.goalId}\ttesting\tcheck in`,
    'setup v1',
    expect.stringContaining('chưa có khoá test') as unknown,
  ]);
  await expect(p.invoke('package', 'submit', p.goalId, 'WP-MAIN', '--commit', p.base)).rejects.toThrow(
    /acceptance tests are not locked yet: run `apos tests submit` first/,
  );
}, 60_000);

it('refuses a bad suite with exit 1 and every problem, then locks a good one and shows it', async () => {
  const p = await cli();
  const bad = p.commit({ ...goodTests(p.goalId), 'tests/acceptance/calc.t': 'case add pass\n' }, 'bad tests');
  expect(await p.invoke('tests', 'submit', p.goalId, '--commit', bad)).toBe(1);
  expect(p.out[0]).toBe(`tests refused on ${bad}: nothing is locked`);
  expect(p.out[1]).toMatch(/already green/);
  p.out.length = 0;
  const good = p.commit(goodTests(p.goalId), 'good tests');
  expect(await p.invoke('tests', 'submit', p.goalId, '--commit', good)).toBeUndefined();
  expect(p.out[0]).toBe('Locked 1 tests in 1 files on ' + good + '. Packages are gated on top of this commit.');
  p.out.length = 0;
  await p.invoke('tests', 'show', p.goalId);
  expect(p.out.join('\n')).toMatch(/khoá test: commit [0-9a-f]{40}, 1 test, 1 file, 1 assert/);
  expect(p.out).toContain('  app.L2: 1 tests');
  expect(p.out).toContain('  AC-1 -> app.L2: tests.acceptance.calc::add');
  p.out.length = 0;
  await p.invoke('goal', 'show', p.goalId);
  expect(p.out[0]).toBe(`${p.goalId}\texecuting\tcheck in`);
}, 90_000);
