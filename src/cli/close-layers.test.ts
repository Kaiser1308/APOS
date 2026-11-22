import { afterEach, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { cleanProjects, lockedProject, setupDocument } from '../app/test-lock.test-support.js';

afterEach(() => {
  process.exitCode = undefined;
  cleanProjects();
});

async function closing(l3Exit: number) {
  const part = setupDocument.parts.app;
  const setup = {
    ...setupDocument,
    parts: {
      app: {
        ...part,
        layers: { ...part.layers, L3: [{ id: 'integ', command: `node -e "process.exit(${l3Exit})"`, format: 'exit' }] },
      },
    },
  };
  const p = await lockedProject({ setup });
  const commit = p.commit({ 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' }, 'implement');
  expect((await p.submit(commit)).result).toBe('green');
  p.close();
  const out: string[] = [];
  const invoke = async (...args: string[]) => {
    await runCli(['--repo', p.dir, ...args], {
      home: p.home,
      gate: { artifactRoot: p.artifacts },
      write: line => out.push(line),
      io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
    });
  };
  return { ...p, commit, out, invoke };
}

it('outcome close runs the close-stage layers on the verified commit, then closes', async () => {
  const p = await closing(0);
  await p.invoke('outcome', 'close', p.goalId, '--on-behalf', 'item 1');
  expect(p.out).toContain(`Close-stage layers green on ${p.commit}`);
  expect(p.out.at(-1)).toBe(`close ${p.goalId}`);
}, 240_000);

it('refuses to close while a close layer is red, names it, and an agent-approved exception unblocks the same commit', async () => {
  const p = await closing(9);
  await expect(p.invoke('outcome', 'close', p.goalId, '--on-behalf', 'item 1')).rejects.toThrow(
    /app\.L3\.integ fail: app\.L3 integ: exit 9/,
  );
  await p.invoke(
    'exception',
    'approve',
    p.goalId,
    '--kind',
    'floor-reduced',
    '--ref',
    `${p.goalId}:close:L3`,
    '--reason',
    'env down',
    '--by',
    'agent:lead',
  );
  await p.invoke('outcome', 'close', p.goalId, '--on-behalf', 'item 1');
  expect(p.out.at(-1)).toBe(`close ${p.goalId}`);
}, 360_000);
