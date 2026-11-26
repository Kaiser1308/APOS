import { newEvent } from '../app/events.js';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, describeError } from '../cli.js';
import { initProject } from '../app/init-project.js';
import { ProjectJournal } from '../store/journal.js';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import { buildInbox } from '../app/inbox.js';
import { buildSnapshot } from '../ui/read-model.js';
import { approval, DELIVERY, proposal, soloGreen, sourceText, spec } from '../domain/fixtures.test-support.js';

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

// Every CLI call commits to a scratch Git repo; a full parallel run on Windows measured 3-5x slower than alone.
describe('PM plan and requirement coverage tracking (#21)', { timeout: 60_000 }, () => {
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
        '--max-minutes',
        '120',
        '--max-attempts',
        '3',
        '--on-behalf',
        'test',
      ),
    ).rejects.toThrow(/sketch|acceptance/i);
  });

  it.each(['adopt', 'revise', 'defer'] as const)('clears an orphan notice through %s', async action => {
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

    const opened = ProjectJournal.open(dir, home, newEvent);
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
    for (const item of soloGreen()) add('GOAL-002', item.type, item.data);
    add('GOAL-002', 'verified', { deliveryCommit: DELIVERY });
    opened.close();

    await invoke('outcome', 'close', 'GOAL-002', '--on-behalf', 'test');

    // R-2 was deferred to GOAL-002, which closed without accepting R-2 -> exactly one notice in inbox
    const inbox1 = buildInbox(new ReadOnlyJournal(home));
    const orphanNotices = inbox1.filter(
      item => item.detail.includes('orphan-requirement') && item.detail.includes('R-2'),
    );
    expect(orphanNotices).toHaveLength(1);
    // The inbox recomputes the orphan; closing writes no orphan event of its own.
    expect(
      new ReadOnlyJournal(home)
        .events('GOAL-002')
        .filter(item => item.type === 'human-notified' && JSON.stringify(item.data).includes('orphan-requirement')),
    ).toHaveLength(0);

    if (action === 'adopt' || action === 'defer') {
      // A new brief explicitly adopts the original requirement and survives journal replay.
      const newBrief = join(dir, 'new-brief.md');
      writeFileSync(newBrief, 'Adopt the deferred requirement');
      const adopter = {
        id: 'GOAL-003',
        version: 1,
        outcome: 'Preserve data',
        requirements: [
          {
            id: action === 'defer' ? 'R-22' : 'R-2',
            sourceSpan: 'new brief',
            text: 'never lose data',
            disposition: action === 'defer' ? 'excluded' : 'acceptance',
            ...(action === 'defer'
              ? { exclusion: { kind: 'deferred', to: 'GOAL-004' }, exclusionReason: 'later' }
              : {}),
            adopts: { sourceSha256: createHash('sha256').update(sourceText).digest('hex'), requirementId: 'R-2' },
          },
        ],
      };
      writeFileSync(join(dir, 'g3.json'), JSON.stringify(adopter));
      await invoke('goal', 'create', '--file', join(dir, 'g3.json'), '--source', newBrief);
      if (action === 'defer') {
        const target = { id: 'GOAL-004', version: 1, outcome: 'Later', requirements: [spec.requirements[0]] };
        writeFileSync(join(dir, 'g4.json'), JSON.stringify(target));
        await invoke('goal', 'create', '--file', join(dir, 'g4.json'), '--source', newBrief);
        const journal = ProjectJournal.open(dir, home, newEvent);
        journal.journal.append({
          id: 'STOP-004',
          goalId: 'GOAL-004',
          type: 'outcome-stopped',
          at: '2026-11-18T06:00:01.000Z',
        });
        journal.close();
        const notices = buildInbox(new ReadOnlyJournal(home)).filter(item =>
          item.detail.includes('orphan-requirement'),
        );
        expect(notices).toHaveLength(1);
        const notice = JSON.parse(notices[0]!.detail);
        const sourceSha256 = createHash('sha256').update('Adopt the deferred requirement').digest('hex');
        expect(notice).toMatchObject({
          requirementId: 'R-22',
          sourceSha256,
          fromGoalId: 'GOAL-003',
          goalId: 'GOAL-004',
        });
        expect(notice.note).toContain(sourceSha256);
        expect(notice.note).toContain('R-22');
        return;
      }
      expect(
        buildInbox(new ReadOnlyJournal(home)).filter(item => item.detail.includes('orphan-requirement')),
      ).toHaveLength(0);

      const stopped = ProjectJournal.open(dir, home, newEvent);
      stopped.journal.append({
        id: 'STOP-003',
        goalId: 'GOAL-003',
        type: 'outcome-stopped',
        at: '2026-11-18T06:00:01.000Z',
      });
      stopped.close();
      expect(
        buildInbox(new ReadOnlyJournal(home)).filter(
          item => item.detail.includes('orphan-requirement') && item.detail.includes('R-2'),
        ),
      ).toHaveLength(1);
    } else {
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
    }
  });

  it('replays legacy Goals that only have exclusionReason as unplanned without breaking the event log', async () => {
    const { dir, home } = await setup();
    const opened = ProjectJournal.open(dir, home, newEvent);
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
});
