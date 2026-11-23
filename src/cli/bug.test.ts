import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { goalKind } from '../domain/contracts.js';
import { applyEvent, type GoalEvent, type GoalState } from '../domain/transitions.js';
import { spec, sourceText } from '../domain/fixtures.test-support.js';
import { buildSnapshot } from '../ui/read-model.js';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import { bugArgs, project, removeTemp, temp } from './bug.test-support.js';

const saved = process.env.APOS_HOME;
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-bug-home-');
});
afterEach(() => {
  process.exitCode = undefined;
  if (saved === undefined) delete process.env.APOS_HOME;
  else process.env.APOS_HOME = saved;
  removeTemp();
});

describe('apos bug open', () => {
  it('drafts a bugfix Goal with one criterion, its check taken from the approved setup', async () => {
    const p = await project({ withSetup: true });
    await p.invoke('bug', 'open', 'Total wrong with FREE0', ...bugArgs, '--repro-hint', 'src/orders.ts');
    const goal = p.state('GOAL-BUG-001')!;
    expect(goalKind(goal.spec)).toBe('bugfix');
    expect(goal.status).toBe('draft');
    expect(goal.spec.acceptance).toHaveLength(1);
    expect(goal.spec.reproHint).toBe('src/orders.ts');
    expect(goal.spec.part).toBe('app');
    expect(goal.spec.checks[0]).toMatchObject({ command: 'node report.js {report}', format: 'junit' });
    expect(p.out.join('\n')).toContain('apos bug approve GOAL-BUG-001');
    await p.invoke('bug', 'open', 'Another', ...bugArgs);
    expect(p.state('GOAL-BUG-002')).toBeDefined();
  });

  it('needs --check without an approved setup, and refuses it with one', async () => {
    const bare = await project();
    await expect(bare.invoke('bug', 'open', 'x', ...bugArgs)).rejects.toThrow(/--check/);
    await bare.invoke('bug', 'open', 'x', ...bugArgs, '--check', 'npm test');
    expect(bare.state('GOAL-BUG-001')!.spec.checks[0]).toMatchObject({ command: 'npm test' });
    const set = await project({ withSetup: true });
    await expect(set.invoke('bug', 'open', 'x', ...bugArgs, '--check', 'npm test')).rejects.toThrow(
      /check comes from the setup/,
    );
  });

  it('asks for --part when the setup has several parts', async () => {
    const p = await project({ withSetup: true, parts: ['api', 'web'] });
    await expect(p.invoke('bug', 'open', 'x', ...bugArgs)).rejects.toThrow(/--part/);
    await p.invoke('bug', 'open', 'x', ...bugArgs, '--part', 'web');
    expect(p.state('GOAL-BUG-001')!.spec.part).toBe('web');
  });

  it('does not take ordinary Goal ids', async () => {
    const p = await project();
    writeFileSync(join(p.dir, 'goal.json'), JSON.stringify(spec));
    writeFileSync(join(p.dir, 'brief.md'), sourceText);
    await p.invoke('goal', 'create', '--file', join(p.dir, 'goal.json'), '--source', join(p.dir, 'brief.md'));
    await p.invoke('bug', 'open', 'x', ...bugArgs, '--check', 'npm test');
    expect(p.state('GOAL-001')).toBeDefined();
    expect(p.state('GOAL-BUG-001')).toBeDefined();
  });

  it('refuses a bugfix Goal made with a second criterion, at creation and at revision', async () => {
    const p = await project();
    const two = {
      ...spec,
      id: 'GOAL-002',
      kind: 'bugfix',
      acceptance: [spec.acceptance[0], { ...spec.acceptance[0], id: 'AC-2' }],
    };
    writeFileSync(join(p.dir, 'brief.md'), sourceText);
    writeFileSync(join(p.dir, 'two.json'), JSON.stringify(two));
    await expect(
      p.invoke('goal', 'create', '--file', join(p.dir, 'two.json'), '--source', join(p.dir, 'brief.md')),
    ).rejects.toThrow(/exactly one/);
    await p.invoke('bug', 'open', 'x', ...bugArgs, '--check', 'npm test');
    const revised = { ...p.state('GOAL-BUG-001')!.spec, version: 2, acceptance: two.acceptance };
    writeFileSync(join(p.dir, 'rev.json'), JSON.stringify(revised));
    await expect(
      p.invoke('goal', 'revise', '--file', join(p.dir, 'rev.json'), '--source', join(p.dir, 'brief.md')),
    ).rejects.toThrow();
  });
});

describe('a bug waiting for approval', () => {
  it('is in apos inbox, in inbox --json and in the UI snapshot, with the command that approves it', async () => {
    const p = await project({ withSetup: true });
    await p.invoke('bug', 'open', 'x', ...bugArgs);
    p.out.length = 0;
    await p.invoke('inbox');
    expect(p.out.join('\n')).toContain('apos bug approve GOAL-BUG-001');
    p.out.length = 0;
    await p.invoke('inbox', '--json');
    expect(p.out.join('\n')).toContain('apos bug approve GOAL-BUG-001');
    const snapshot = buildSnapshot(new ReadOnlyJournal(p.home));
    expect(snapshot.inbox.map(item => item.detail)).toContain('gates A and B in one go: apos bug approve GOAL-BUG-001');
    await p.invoke('bug', 'approve', 'GOAL-BUG-001', '--on-behalf', 'x');
    p.out.length = 0;
    await p.invoke('inbox');
    expect(p.out.join('\n')).not.toContain('GOAL-BUG-001');
  });
});

describe('apos bug approve', () => {
  const human = ['--on-behalf', 'item 1'];
  const opened = async () => {
    const p = await project({ withSetup: true });
    await p.invoke('bug', 'open', 'x', ...bugArgs);
    return p;
  };

  it('refuses without a Human confirmation and writes nothing', async () => {
    const p = await opened();
    const before = p.events('GOAL-BUG-001').length;
    await expect(p.invoke('bug', 'approve', 'GOAL-BUG-001')).rejects.toThrow(/Human decision/);
    expect(p.events('GOAL-BUG-001')).toHaveLength(before);
    expect(p.state('GOAL-BUG-001')!.status).toBe('draft');
  });

  it('refuses a Goal that is not a bugfix and points to goal approve', async () => {
    const p = await project();
    writeFileSync(join(p.dir, 'goal.json'), JSON.stringify(spec));
    writeFileSync(join(p.dir, 'brief.md'), sourceText);
    await p.invoke('goal', 'create', '--file', join(p.dir, 'goal.json'), '--source', join(p.dir, 'brief.md'));
    await expect(p.invoke('bug', 'approve', 'GOAL-001', ...human)).rejects.toThrow(/goal approve/);
    expect(p.state('GOAL-001')!.status).toBe('draft');
  });

  it('approves, sets the default appetite and selects: S, 60 minutes, 3 attempts, on the latest setup', async () => {
    const p = await opened();
    await p.invoke('bug', 'approve', 'GOAL-BUG-001', ...human);
    const goal = p.state('GOAL-BUG-001')!;
    expect(goal.status).toBe('selected');
    expect(goal.appetite).toMatchObject({ size: 'S', maxWallMinutes: 60, maxAttempts: 3 });
    expect(goal.setupVersion).toBe(1);
    expect(goal.bugApproval).toEqual({ by: 'on-behalf', onBehalf: 'item 1' });
    const types = p.events('GOAL-BUG-001').map(item => item.type);
    expect(types.filter(type => type !== 'documents-published').slice(-3)).toEqual([
      'goal-approved',
      'appetite-set',
      'goal-selected',
    ]);
  });

  it('flags override the defaults', async () => {
    const p = await opened();
    await p.invoke('bug', 'approve', 'GOAL-BUG-001', ...human, '--appetite', 'M', '--minutes', '90', '--attempts', '5');
    expect(p.state('GOAL-BUG-001')!.appetite).toMatchObject({ size: 'M', maxWallMinutes: 90, maxAttempts: 5 });
  });

  it('writes the same state as goal approve, goal appetite and goal select, and every event carries the same confirmation', async () => {
    const a = await opened();
    await a.invoke('bug', 'approve', 'GOAL-BUG-001', ...human);
    const b = await opened();
    const flags = ['--size', 'S', '--max-minutes', '60', '--max-attempts', '3', ...human];
    await b.invoke('goal', 'approve', 'GOAL-BUG-001', ...flags);
    await b.invoke('goal', 'appetite', 'GOAL-BUG-001', ...flags, '--reason', 'default');
    await b.invoke('goal', 'select', 'GOAL-BUG-001', ...human);
    const replay = (events: GoalEvent[]): GoalState => {
      let state: GoalState | undefined;
      for (const item of events) state = applyEvent(state, item);
      return state!;
    };
    // What a Goal is after the three events; the spec's capture time, the document commit and the via mark are not part of it.
    const stateOf = (p: Awaited<ReturnType<typeof opened>>) => {
      const state = replay(p.events('GOAL-BUG-001'));
      return {
        status: state.status,
        selected: state.selected,
        appetite: state.appetite,
        setupVersion: state.setupVersion,
        flags: state.flags,
        approvedGoalVersion: state.approvedGoalVersion,
      };
    };
    expect(stateOf(a)).toEqual(stateOf(b));
    const tail = a
      .events('GOAL-BUG-001')
      .filter(item => item.type !== 'documents-published')
      .slice(-3);
    for (const item of tail) {
      expect((item.data as { confirmation: unknown }).confirmation).toEqual({ by: 'on-behalf', onBehalf: 'item 1' });
      expect((item.data as { via: unknown }).via).toBe('bug approve');
    }
  });

  it('behaves like goal approve on setup: a flag with no tool behind it is refused and nothing is written', async () => {
    const p = await opened();
    const before = p.events('GOAL-BUG-001').length;
    await expect(p.invoke('bug', 'approve', 'GOAL-BUG-001', ...human, '--flag', 'mutation')).rejects.toThrow(
      /no tool that says/,
    );
    expect(p.events('GOAL-BUG-001')).toHaveLength(before);
  });

  it('with no approved setup the Goal is approved without one and says so', async () => {
    const p = await project();
    await p.invoke('bug', 'open', 'x', ...bugArgs, '--check', 'npm test');
    await p.invoke('bug', 'approve', 'GOAL-BUG-001', ...human);
    expect(p.state('GOAL-BUG-001')!.setupVersion).toBeUndefined();
    expect(p.err.join('\n')).toMatch(/không có setup/);
  });

  it('refuses a second approval', async () => {
    const p = await opened();
    await p.invoke('bug', 'approve', 'GOAL-BUG-001', ...human);
    await expect(p.invoke('bug', 'approve', 'GOAL-BUG-001', ...human)).rejects.toThrow(/still in draft/);
  });

  it('refuses before writing anything when select would refuse for an open dependency', async () => {
    const p = await project();
    writeFileSync(join(p.dir, 'brief.md'), sourceText);
    const create = async (name: string, goal: unknown) => {
      writeFileSync(join(p.dir, name), JSON.stringify(goal));
      await p.invoke('goal', 'create', '--file', join(p.dir, name), '--source', join(p.dir, 'brief.md'));
    };
    await create('a.json', spec);
    await create('b.json', { ...spec, id: 'GOAL-BUG-009', kind: 'bugfix', dependencies: [spec.id] });
    const before = p.events('GOAL-BUG-009').length;
    await expect(p.invoke('bug', 'approve', 'GOAL-BUG-009', ...human)).rejects.toThrow(/dependency GOAL-001/);
    expect(p.events('GOAL-BUG-009')).toHaveLength(before);
  });
});
