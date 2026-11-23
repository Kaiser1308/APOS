import { afterEach, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { cleanProjects, lockedProject } from '../app/test-lock.test-support.js';

afterEach(() => {
  process.exitCode = undefined;
  cleanProjects();
});

async function cli() {
  const p = await lockedProject();
  const commit = p.commit({ 'src/impl.txt': 'add\n', 'pyproject.toml': '[project]\n' }, 'deps');
  p.close();
  const out: string[] = [];
  const invoke = async (...args: string[]) => {
    process.exitCode = undefined;
    await runCli(['--repo', p.dir, ...args], {
      home: p.home,
      gate: { artifactRoot: p.artifacts },
      write: line => out.push(line),
      io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
    });
    return process.exitCode as number | undefined;
  };
  return { ...p, commit, out, invoke };
}

it('walks a sensitive-file change through the CLI: needs-human (exit 3), approved by an agent, green on the same commit', async () => {
  const p = await cli();
  expect(await p.invoke('package', 'submit', p.goalId, 'WP-MAIN', '--commit', p.commit)).toBe(3);
  expect(p.out[0]).toBe(`WP-MAIN needs-human on ${p.commit}`);
  p.out.length = 0;
  await p.invoke(
    'exception',
    'approve',
    p.goalId,
    '--kind',
    'needs-human',
    '--ref',
    'WP-MAIN',
    '--reason',
    'lock bump',
    '--by',
    'agent:lead',
  );
  expect(p.out[0]).toBe(
    `Approved needs-human for WP-MAIN on ${p.commit} by agent:lead. Submit WP-MAIN again with the same commit.`,
  );
  p.out.length = 0;
  expect(await p.invoke('package', 'submit', p.goalId, 'WP-MAIN', '--commit', p.commit)).toBe(0);
  expect(p.out[0]).toBe(`WP-MAIN green on ${p.commit}; ${p.goalId} verified`);
}, 240_000);

it('needs exactly one of --by and --human, and --human is a Human decision: a terminal or --on-behalf', async () => {
  const p = await cli();
  await p.invoke('package', 'submit', p.goalId, 'WP-MAIN', '--commit', p.commit);
  const base = ['exception', 'approve', p.goalId, '--kind', 'needs-human', '--ref', 'WP-MAIN', '--reason', 'r'];
  await expect(p.invoke(...base)).rejects.toThrow(/exactly one of --by agent:<name> or --human/);
  await expect(p.invoke(...base, '--by', 'agent:x', '--human')).rejects.toThrow(/exactly one/);
  await expect(p.invoke(...base, '--human')).rejects.toThrow(/Human decision/);
  await expect(p.invoke(...base, '--by', 'lead')).rejects.toThrow(/--by is agent:<name>/);
  p.out.length = 0;
  await p.invoke(...base, '--human', '--on-behalf', 'item 7');
  expect(p.out[0]).toMatch(/by the Human/);
}, 240_000);
