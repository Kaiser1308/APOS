import { afterEach, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { cleanProjects, lockedProject, setupDocument } from '../app/test-lock.test-support.js';
import { spec } from '../domain/fixtures.test-support.js';
import { ProjectJournal } from '../store/journal.js';

afterEach(() => {
  process.exitCode = undefined;
  cleanProjects();
});

it('does not close when target changes make the merged integration layer fail', async () => {
  const part = setupDocument.parts.app;
  const setup = {
    ...setupDocument,
    parts: {
      app: {
        ...part,
        layers: { ...part.layers, L3: [{ id: 'integration', command: 'node integration.cjs', format: 'exit' }] },
      },
    },
  };
  const goal = { ...spec, checks: [{ ...spec.checks[0]!, command: 'node feature.cjs' }] };
  const p = await lockedProject({
    setup,
    goal,
    files: {
      'config.txt': 'good',
      'feature.cjs': "process.exit(require('node:fs').readFileSync('src/impl.txt','utf8').includes('add') ? 0 : 1);\n",
      'integration.cjs': "process.exit(require('node:fs').readFileSync('config.txt','utf8') === 'good' ? 0 : 9);\n",
    },
  });
  p.git('checkout', '-qb', 'worker');
  const delivery = p.commit({ 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' }, 'implementation');
  expect((await p.submit(delivery)).result).toBe('green');
  p.close();
  p.git('checkout', '-q', 'main');
  p.commit({ 'config.txt': 'bad' }, 'independent target change');
  await expect(
    runCli(['--repo', p.dir, 'outcome', 'close', p.goalId, '--merge-to', 'main', '--on-behalf', 'fixture'], {
      home: p.home,
      gate: { artifactRoot: p.artifacts },
      write: () => {},
      io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
    }),
  ).rejects.toThrow(/Post-merge gate is red/);
  const mergeHead = p.git('rev-parse', 'HEAD');
  await expect(
    runCli(['--repo', p.dir, 'outcome', 'close', p.goalId, '--on-behalf', 'fixture'], {
      home: p.home,
      gate: { artifactRoot: p.artifacts },
      write: () => {},
      io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
    }),
  ).rejects.toThrow(/Post-merge gate is red/);
  expect(p.git('rev-parse', 'HEAD')).toBe(mergeHead);
  const opened = ProjectJournal.open(p.dir, p.home);
  try {
    const state = opened.journal.getGoal(p.goalId)!;
    expect(state.status).toBe('verified');
    expect(state.closeGate).toMatchObject({ result: 'green', deliveryCommit: delivery });
    expect(state.postMergeGate).toMatchObject({ result: 'red', deliveryCommit: state.merge!.mergeCommit });
    expect(state.postMergeGate!.checks).toContainEqual(
      expect.objectContaining({ checkId: 'app.L3.integration', status: 'fail' }),
    );
  } finally {
    opened.close();
  }
}, 240_000);

it('closes with merge commit evidence when the pinned layers pass', async () => {
  const part = setupDocument.parts.app;
  const setup = {
    ...setupDocument,
    parts: {
      app: {
        ...part,
        layers: { ...part.layers, L3: [{ id: 'integration', command: 'node integration.cjs', format: 'exit' }] },
      },
    },
  };
  const p = await lockedProject({ setup, files: { 'integration.cjs': 'process.exit(0);\n' } });
  p.git('checkout', '-qb', 'worker');
  const delivery = p.commit({ 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' }, 'implementation');
  expect((await p.submit(delivery)).result).toBe('green');
  p.close();
  p.git('checkout', '-q', 'main');
  p.commit({ 'other.txt': 'target changed' }, 'target change');
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
    expect(state.status).toBe('closed');
    expect(state.postMergeGate).toMatchObject({ result: 'green', deliveryCommit: state.merge!.mergeCommit });
    expect(state.postMergeGate!.checks).toContainEqual(
      expect.objectContaining({ checkId: 'app.L3.integration', status: 'pass' }),
    );
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ verdict: 'green' });
  } finally {
    opened.close();
  }
}, 240_000);
