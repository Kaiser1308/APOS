import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spec, sourceText } from '../domain/fixtures.test-support.js';
import { bugArgs, project, removeTemp, temp } from './bug.test-support.js';

const saved = process.env.APOS_HOME;
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-bugplan-home-');
});
afterEach(() => {
  process.exitCode = undefined;
  if (saved === undefined) delete process.env.APOS_HOME;
  else process.env.APOS_HOME = saved;
  removeTemp();
});

const human = ['--on-behalf', 'item 1'];
const approved = async (...open: string[]) => {
  const p = await project({ withSetup: true });
  await p.invoke('bug', 'open', 'Total wrong', ...bugArgs, ...open);
  await p.invoke('bug', 'approve', 'GOAL-BUG-001', ...human);
  return p;
};

describe('apos lead propose --bugfix', () => {
  it('writes a Solo plan: paths from the part, the hint as the stub, the base as HEAD, and lead commit takes it', async () => {
    const p = await approved('--repro-hint', 'src/orders.ts');
    await p.invoke('lead', 'propose', '--bugfix', '--goal', 'GOAL-BUG-001');
    const goal = p.state('GOAL-BUG-001')!;
    expect(goal.proposal).toMatchObject({
      mode: 'solo-direct',
      goalId: 'GOAL-BUG-001',
      baseCommit: p.git('rev-parse', 'HEAD'),
      paths: ['**'],
      stubPaths: ['src/orders.ts'],
      sourceSha256: goal.spec.source.sha256,
      acceptanceMapping: [{ acceptanceId: 'AC-1' }],
    });
    await p.invoke('lead', 'commit', 'GOAL-BUG-001');
    expect(p.state('GOAL-BUG-001')!.status).toBe('executing');
  });

  it('takes --stub and --base, which beat the hint and HEAD', async () => {
    const p = await approved('--repro-hint', 'src/orders.ts');
    const base = p.git('rev-parse', 'HEAD');
    await p.invoke('lead', 'propose', '--bugfix', '--goal', 'GOAL-BUG-001', '--stub', 'src/cart.ts', '--base', base);
    expect(p.state('GOAL-BUG-001')!.proposal?.stubPaths).toEqual(['src/cart.ts']);
  });

  it('needs the Lead to name the stub when the Goal has no repro hint', async () => {
    const p = await approved();
    await expect(p.invoke('lead', 'propose', '--bugfix', '--goal', 'GOAL-BUG-001')).rejects.toThrow(/--stub/);
    await p.invoke('lead', 'propose', '--bugfix', '--goal', 'GOAL-BUG-001', '--stub', 'src/orders.ts');
    expect(p.state('GOAL-BUG-001')!.proposal).toBeDefined();
  });

  it('is for a bugfix Goal, and takes either --file or --bugfix', async () => {
    const p = await project();
    writeFileSync(join(p.dir, 'goal.json'), JSON.stringify(spec));
    writeFileSync(join(p.dir, 'brief.md'), sourceText);
    await p.invoke('goal', 'create', '--file', join(p.dir, 'goal.json'), '--source', join(p.dir, 'brief.md'));
    await expect(p.invoke('lead', 'propose', '--bugfix', '--goal', 'GOAL-001')).rejects.toThrow(/not a bugfix Goal/);
    await expect(p.invoke('lead', 'propose')).rejects.toThrow(/either --file/);
    await expect(p.invoke('lead', 'propose', '--file', 'x.json', '--bugfix', '--goal', 'GOAL-001')).rejects.toThrow(
      /either --file/,
    );
  });
});
