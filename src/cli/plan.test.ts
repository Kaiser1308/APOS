import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, describeError } from '../cli.js';
import { initProject } from '../app/init-project.js';
import { ProjectJournal } from '../store/journal.js';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import { buildInbox } from '../app/inbox.js';
import { buildSnapshot } from '../ui/read-model.js';
import { approval, proposal, sourceText, spec } from '../domain/fixtures.test-support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'apos-plan-repo-'));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), 'apos-plan-home-'));
  dirs.push(home);
  execFileSync('git', ['init', '-q', dir]);
  await initProject(dir);
  const sourceFile = join(dir, 'brief.md');
  writeFileSync(sourceFile, sourceText);
  const out: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], {
      home,
      write: line => out.push(line),
    });
  return { dir, home, sourceFile, out, invoke };
}

describe('PM plan and requirement coverage tracking (#21)', () => {
  it('refuses goal create when an excluded requirement lacks exclusion.kind, naming the field', async () => {
    const { dir, sourceFile, invoke } = await setup();
    const badGoal = {
      ...spec,
      requirements: [
        spec.requirements[0],
        {
          id: 'R-2',
          sourceSpan: 'line 4',
          text: 'offline sync never loses data',
          disposition: 'excluded',
          exclusionReason: 'later in GOAL-002',
        },
      ],
    };
    const file = join(dir, 'goal-bad.json');
    writeFileSync(file, JSON.stringify(badGoal));
    let caught: unknown;
    try {
      await invoke('goal', 'create', '--file', file, '--source', sourceFile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(describeError(caught)).toMatch(/requirements\.1\.exclusion\.kind/);
  });

  it('tracks deferred requirements in apos plan and UI before GOAL-002 exists, and supports sketch Goals', async () => {
    const { dir, home, sourceFile, out, invoke } = await setup();
    const goal1 = {
      ...spec,
      id: 'GOAL-001',
      requirements: [
        spec.requirements[0],
        {
          id: 'R-2',
          sourceSpan: 'line 4',
          text: 'offline mode',
          disposition: 'excluded',
          exclusion: { kind: 'deferred', to: 'GOAL-002' },
          exclusionReason: 'deferred to GOAL-002',
        },
        {
          id: 'R-3',
          sourceSpan: 'line 5',
          text: 'concurrent edit merge',
          disposition: 'excluded',
          exclusion: { kind: 'deferred', to: 'GOAL-002' },
          exclusionReason: 'deferred to GOAL-002',
        },
        {
          id: 'R-5',
          sourceSpan: 'line 6',
          text: 'never lose data',
          disposition: 'excluded',
          exclusion: { kind: 'deferred', to: 'GOAL-002' },
          exclusionReason: 'deferred to GOAL-002',
        },
      ],
    };
    const f1 = join(dir, 'goal1.json');
    writeFileSync(f1, JSON.stringify(goal1));
    await invoke('goal', 'create', '--file', f1, '--source', sourceFile);

    out.length = 0;
    await invoke('plan', '--source', sourceFile);
    const planText = out.join('\n');
    expect(planText).toContain('GOAL-002');
    expect(planText).toMatch(/R-2\tdeferred\tGOAL-002/);
    expect(planText).toMatch(/R-3\tdeferred\tGOAL-002/);
    expect(planText).toMatch(/R-5\tdeferred\tGOAL-002/);

    const snap = buildSnapshot(new ReadOnlyJournal(home));
    expect(snap.plan?.goals.some(g => g.id === 'GOAL-002' && g.status === 'deferred')).toBe(true);
    expect(
      snap.plan?.requirements
        .filter(r => ['R-2', 'R-3', 'R-5'].includes(r.id))
        .every(r => r.status === 'deferred' && r.goalId === 'GOAL-002'),
    ).toBe(true);

    // Create GOAL-002 as a sketch Goal (outcome + requirements only, no acceptance/checks yet)
    const sketch2 = {
      id: 'GOAL-002',
      version: 1,
      outcome: 'Offline sync and conflict resolution',
      requirements: [
        { id: 'R-2', sourceSpan: 'line 4', text: 'offline mode', disposition: 'acceptance' },
        { id: 'R-3', sourceSpan: 'line 5', text: 'concurrent edit merge', disposition: 'acceptance' },
        { id: 'R-5', sourceSpan: 'line 6', text: 'never lose data', disposition: 'acceptance' },
      ],
    };
    const f2 = join(dir, 'goal2-sketch.json');
    writeFileSync(f2, JSON.stringify(sketch2));
    await invoke('goal', 'create', '--file', f2, '--source', sourceFile);

    // Sketch Goal cannot be approved until revised into a full Goal
    await expect(
      invoke(
        'goal',
        'approve',
        'GOAL-002',
        '--size',
        'M',
        '--max-spend',
        '10',
        '--max-minutes',
        '120',
        '--max-attempts',
        '3',
      ),
    ).rejects.toThrow(/sketch|acceptance/i);
  });

  it('notifies once when a closed Goal orphans a deferred requirement, and clears the notice when adopted or out-of-scope', async () => {
    const { dir, home, sourceFile, invoke } = await setup();
    const goal1 = {
      ...spec,
      id: 'GOAL-001',
      requirements: [
        spec.requirements[0],
        {
          id: 'R-2',
          sourceSpan: 'line 4',
          text: 'never lose data',
          disposition: 'excluded',
          exclusion: { kind: 'deferred', to: 'GOAL-002' },
          exclusionReason: 'deferred to GOAL-002',
        },
      ],
    };
    const goal2WithoutR2 = {
      ...spec,
      id: 'GOAL-002',
      requirements: [spec.requirements[0]],
    };
    writeFileSync(join(dir, 'g1.json'), JSON.stringify(goal1));
    writeFileSync(join(dir, 'g2.json'), JSON.stringify(goal2WithoutR2));
    await invoke('goal', 'create', '--file', join(dir, 'g1.json'), '--source', sourceFile);
    await invoke('goal', 'create', '--file', join(dir, 'g2.json'), '--source', sourceFile);

    const opened = ProjectJournal.open(dir, home);
    let n = 0;
    const add = (goalId: string, type: string, data?: unknown) =>
      opened.journal.append({
        id: `ORPH-${++n}`,
        goalId,
        type: type as never,
        data,
        at: '2026-11-18T06:00:00.000Z',
      });
    add('GOAL-002', 'goal-approved', approval);
    add('GOAL-002', 'goal-selected');
    add('GOAL-002', 'proposal-drafted', { ...proposal, goalId: 'GOAL-002' });
    add('GOAL-002', 'proposal-approved');
    add('GOAL-002', 'execution-started', { runId: 'r', taskId: 't', dispatchId: 'd', owner: 'lead', repoPath: dir });
    add('GOAL-002', 'verified');
    opened.close();

    await invoke('outcome', 'close', 'GOAL-002');

    // R-2 was deferred to GOAL-002, which closed without accepting R-2 -> exactly one notice in inbox
    const inbox1 = buildInbox(new ReadOnlyJournal(home));
    const orphanNotices = inbox1.filter(
      item => item.detail.includes('orphan-requirement') && item.detail.includes('R-2'),
    );
    expect(orphanNotices).toHaveLength(1);

    // Revise GOAL-001 to mark R-2 out-of-scope -> notice disappears
    const goal1Revised = {
      ...goal1,
      version: 2,
      requirements: [
        spec.requirements[0],
        {
          id: 'R-2',
          sourceSpan: 'line 4',
          text: 'never lose data',
          disposition: 'excluded',
          exclusion: { kind: 'out-of-scope' },
          exclusionReason: 'Human decided out of scope',
        },
      ],
    };
    writeFileSync(join(dir, 'g1-v2.json'), JSON.stringify(goal1Revised));
    await invoke('goal', 'revise', '--file', join(dir, 'g1-v2.json'), '--source', sourceFile);

    const inbox2 = buildInbox(new ReadOnlyJournal(home));
    expect(inbox2.filter(item => item.detail.includes('orphan-requirement'))).toHaveLength(0);
  });

  it('replays legacy Goals that only have exclusionReason as unplanned without breaking the event log', async () => {
    const { dir, home } = await setup();
    const opened = ProjectJournal.open(dir, home);
    const legacySpec = {
      ...spec,
      id: 'GOAL-LEGACY',
      requirements: [
        spec.requirements[0],
        {
          id: 'R-OLD',
          sourceSpan: 'line 9',
          text: 'old excluded req without exclusion object',
          disposition: 'excluded',
          exclusionReason: 'excluded before #21',
        },
      ],
    };
    opened.journal.appendWithSource(
      {
        id: 'LEG-1',
        goalId: 'GOAL-LEGACY',
        type: 'goal-drafted',
        data: legacySpec,
        at: '2026-11-10T00:00:00.000Z',
      },
      sourceText,
    );
    opened.close();
    const ro = new ReadOnlyJournal(home);
    expect([...ro.failures]).toEqual([]);
    const snap = buildSnapshot(ro);
    expect(snap.plan?.requirements.find(r => r.id === 'R-OLD')?.status).toBe('unplanned');
  });

  it('lead recommend prioritizes the approved Goal holding the most accepted requirements', async () => {
    const { dir, home, sourceFile, out, invoke } = await setup();
    const g1 = { ...spec, id: 'GOAL-001', priority: 1 };
    const g2 = {
      ...spec,
      id: 'GOAL-002',
      priority: 1,
      requirements: [
        spec.requirements[0],
        { id: 'R-2', sourceSpan: 'line 4', text: 'second req', disposition: 'acceptance' },
        { id: 'R-3', sourceSpan: 'line 5', text: 'third req', disposition: 'acceptance' },
      ],
      acceptance: [{ ...spec.acceptance[0], requirementIds: ['R-1', 'R-2', 'R-3'] }],
    };
    writeFileSync(join(dir, 'small.json'), JSON.stringify(g1));
    writeFileSync(join(dir, 'big.json'), JSON.stringify(g2));
    await invoke('goal', 'create', '--file', join(dir, 'small.json'), '--source', sourceFile);
    await invoke('goal', 'create', '--file', join(dir, 'big.json'), '--source', sourceFile);
    await invoke(
      'goal',
      'approve',
      'GOAL-001',
      '--size',
      'S',
      '--max-spend',
      '5',
      '--max-minutes',
      '60',
      '--max-attempts',
      '2',
    );
    await invoke(
      'goal',
      'approve',
      'GOAL-002',
      '--size',
      'M',
      '--max-spend',
      '10',
      '--max-minutes',
      '120',
      '--max-attempts',
      '2',
    );
    out.length = 0;
    await invoke('lead', 'recommend');
    expect(out.at(-1)).toMatch(/^GOAL-002:/);
    void home;
  });
});
