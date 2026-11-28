import { afterEach, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { cleanProjects, lockedProject } from '../app/test-lock.test-support.js';
import { ProjectJournal } from '../store/journal.js';

afterEach(() => {
  process.exitCode = undefined;
  cleanProjects();
});

it.each([
  { file: 'tests/acceptance/calc.t', content: 'case add pass\n', check: 'APOS-LOCKED', status: 'fail' },
  { file: 'tests/infra.cfg', content: 'changed helper\n', check: 'APOS-INFRA', status: 'needs-human' },
])(
  'blocks close when target independently changes locked $file',
  async ({ file, content, check, status }) => {
    const p = await lockedProject();
    p.git('checkout', '-qb', 'worker');
    const delivery = p.commit({ 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' }, 'implement');
    expect((await p.submit(delivery)).result).toBe('green');
    expect(p.state().testLock?.files['tests/acceptance/calc.t']).toBeDefined();
    expect(p.state().testLock?.infra?.['tests/infra.cfg']).toBeDefined();
    p.close();
    p.git('checkout', '-q', 'main');
    p.git('merge', '--ff-only', p.lockCommit);
    p.commit({ [file]: content }, 'target changes locked test asset');
    const output: string[] = [];
    await runCli(
      ['--repo', p.dir, 'outcome', 'close', p.goalId, '--merge-to', 'main', '--on-behalf', 'fixture', '--json'],
      {
        home: p.home,
        gate: { artifactRoot: p.artifacts },
        write: line => output.push(line),
        io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
      },
    );
    const opened = ProjectJournal.open(p.dir, p.home);
    try {
      const state = opened.journal.getGoal(p.goalId)!;
      expect(state.status).toBe('verified');
      expect(state.postMergeGate?.deliveryCommit).toBe(state.merge?.mergeCommit);
      expect(state.postMergeGate?.result).not.toBe('green');
      expect(state.postMergeGate?.checks).toContainEqual(expect.objectContaining({ checkId: check, status }));
    } finally {
      opened.close();
    }
  },
  240_000,
);
