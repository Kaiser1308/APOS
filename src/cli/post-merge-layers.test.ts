import { afterEach, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { cleanProjects, lockedProject, setupDocument } from '../app/test-lock.test-support.js';
import { spec } from '../domain/fixtures.test-support.js';
import { ProjectJournal } from '../store/journal.js';
import { MergeService } from '../app/merge.js';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  try {
    writeFileSync(join(p.home, 'gate.lease'), JSON.stringify({ pid: other.pid, at: new Date().toISOString() }));
    await expect(
      runCli(['--repo', p.dir, 'outcome', 'close', p.goalId, '--on-behalf', 'fixture'], {
        home: p.home,
        gate: { artifactRoot: p.artifacts },
        write: () => {},
        io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
      }),
    ).rejects.toThrow(/Another gate is running/);
  } finally {
    other.kill();
    rmSync(join(p.home, 'gate.lease'));
  }
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

it('integration merge does not update the target when another process holds the gate lease', async () => {
  const p = await lockedProject();
  p.git('checkout', '-qb', 'worker');
  const delivery = p.commit({ 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' }, 'implementation');
  expect((await p.submit(delivery)).result).toBe('green');
  new MergeService(p.journal).authorize(p.goalId, 'main', 'fixture');
  p.close();
  p.git('checkout', '-q', 'main');
  const target = p.git('rev-parse', 'HEAD');
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  try {
    writeFileSync(join(p.home, 'gate.lease'), JSON.stringify({ pid: other.pid, at: new Date().toISOString() }));
    await expect(
      runCli(['--repo', p.dir, 'integration', 'merge', p.goalId, '--source', delivery, '--target', 'main'], {
        home: p.home,
        gate: { artifactRoot: p.artifacts },
        write: () => {},
      }),
    ).rejects.toThrow(/Another gate is running/);
    expect(p.git('rev-parse', 'HEAD')).toBe(target);
    const opened = ProjectJournal.open(p.dir, p.home);
    try {
      expect(opened.journal.getGoal(p.goalId)!.merge).toBeUndefined();
    } finally {
      opened.close();
    }
  } finally {
    other.kill();
  }
}, 240_000);

it('busy close reports unverifiable in JSON without merging', async () => {
  const p = await lockedProject();
  p.git('checkout', '-qb', 'worker');
  const delivery = p.commit({ 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' }, 'implementation');
  expect((await p.submit(delivery)).result).toBe('green');
  p.close();
  p.git('checkout', '-q', 'main');
  const target = p.git('rev-parse', 'HEAD');
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  const output: string[] = [];
  try {
    writeFileSync(join(p.home, 'gate.lease'), JSON.stringify({ pid: other.pid, at: new Date().toISOString() }));
    await runCli(
      ['--repo', p.dir, 'outcome', 'close', p.goalId, '--merge-to', 'main', '--on-behalf', 'fixture', '--json'],
      {
        home: p.home,
        gate: { artifactRoot: p.artifacts },
        write: line => output.push(line),
        io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
      },
    );
    expect(process.exitCode).toBe(3);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ verdict: 'unverifiable', status: 'verified', merge: null });
    expect(p.git('rev-parse', 'HEAD')).toBe(target);
  } finally {
    other.kill();
  }
}, 240_000);

it('keeps a Goal verified if the merged layer report is unreadable', async () => {
  const part = setupDocument.parts.app;
  const setup = {
    ...setupDocument,
    parts: {
      app: {
        ...part,
        layers: {
          ...part.layers,
          L3: [{ id: 'integration', command: 'node integration.cjs {report}', format: 'junit' }],
        },
      },
    },
  };
  const p = await lockedProject({
    setup,
    files: {
      'config.txt': 'good',
      'integration.cjs':
        "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], fs.readFileSync('config.txt','utf8') === 'good' ? '<testsuite><testcase classname=\"integration\" name=\"ok\"/></testsuite>' : 'bad report');\n",
    },
  });
  p.git('checkout', '-qb', 'worker');
  const delivery = p.commit({ 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' }, 'implementation');
  expect((await p.submit(delivery)).result).toBe('green');
  p.close();
  p.git('checkout', '-q', 'main');
  p.commit({ 'config.txt': 'bad' }, 'target change');
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
  expect(process.exitCode).toBe(3);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ verdict: 'unverifiable', status: 'verified' });
  const opened = ProjectJournal.open(p.dir, p.home);
  try {
    const state = opened.journal.getGoal(p.goalId)!;
    expect(state.postMergeGate).toMatchObject({ result: 'unverifiable', deliveryCommit: state.merge!.mergeCommit });
    expect(state.postMergeGate!.checks).toContainEqual(
      expect.objectContaining({ checkId: 'app.L3.integration', status: 'unverifiable' }),
    );
  } finally {
    opened.close();
  }
}, 240_000);
