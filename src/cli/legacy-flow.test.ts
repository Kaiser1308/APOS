import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RUNNER, setupDocument } from '../app/test-lock.test-support.js';
import { buildSnapshot } from '../ui/read-model.js';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { project, removeTemp, temp } from './bug.test-support.js';

const saved = process.env.APOS_HOME;
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-legacyflow-home-');
});
afterEach(() => {
  process.exitCode = undefined;
  if (saved === undefined) delete process.env.APOS_HOME;
  else process.env.APOS_HOME = saved;
  removeTemp();
});

const human = ['--on-behalf', 'item 1'];
const goalJson = (extra: object) => ({
  version: 1,
  outcome: 'x',
  requirements: [{ id: 'R-1', sourceSpan: 'l1', text: 'x', disposition: 'acceptance' }],
  scope: ['src'],
  priority: 1,
  ...extra,
});
const characterizeGoal = goalJson({
  id: 'GOAL-C1',
  outcome: 'Capture what impl does today',
  acceptance: [
    {
      id: 'AC-1',
      text: 'add works the way it does today',
      requirementIds: ['R-1'],
      checkIds: ['CHK-1'],
      given: 'the impl',
      when: 'add is called',
      then: 'it adds',
    },
  ],
  checks: [{ id: 'CHK-1', kind: 'command', command: 'node -e "process.exit(0)"', expect: 'pass' }],
});
const refactorGoal = (paths: string[], version = 1) =>
  goalJson({ id: 'GOAL-R1', version, kind: 'refactor', paths, outcome: 'Tidy impl, same behaviour' });

/** A repo with legacy code (src/impl.txt) that nothing but the baseline tests touches. */
async function legacyRepo() {
  const p = await project();
  const put = (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(p.dir, name)), { recursive: true });
      writeFileSync(join(p.dir, name), content);
    }
  };
  const commit = (files: Record<string, string>, message: string) => {
    put(files);
    p.git('add', '-A');
    p.git('commit', '-qm', message);
    return p.git('rev-parse', 'HEAD');
  };
  // Outside the repo, so a commit of the Tester's never carries them.
  const scratch = temp('apos-legacyflow-json-');
  const json = (name: string, value: unknown) => {
    writeFileSync(join(scratch, name), JSON.stringify(value));
    return join(scratch, name);
  };
  const first = commit(
    {
      'runner.js': RUNNER,
      '.apos/project.yaml': jsonCodec.stringify(setupDocument),
      'src/impl.txt': 'add\n',
      'src/other.txt': 'other\n',
      'tests/unit/u.t': 'case one pass\n',
      'tests/acceptance/base.t': 'case base pass\n',
      'tests/infra.cfg': 'plain\n',
      'brief.md': '# brief\n',
    },
    'legacy repo',
  );
  await p.invoke('setup', 'probe', '--commit', first);
  await p.invoke('setup', 'approve', '--commit', first, ...human);
  const approve = (id: string) =>
    p.invoke('goal', 'approve', id, '--size', 'M', '--max-minutes', '240', '--max-attempts', '3', ...human);
  return { ...p, commit, json, approve, brief: join(p.dir, 'brief.md') };
}

describe('characterize, then refactor', () => {
  it('captures behaviour with locked green tests, and a refactor keeps every one of them green', async () => {
    const p = await legacyRepo();
    // A characterize Goal: --kind and --covers on the command line.
    await p.invoke(
      'goal',
      'create',
      '--file',
      p.json('c.json', characterizeGoal),
      '--source',
      p.brief,
      '--kind',
      'characterize',
      '--covers',
      'src/impl.txt',
    );
    expect(p.state('GOAL-C1')?.spec).toMatchObject({ kind: 'characterize', covers: ['src/impl.txt'] });
    expect(p.state('GOAL-C1')?.spec.acceptance[0]?.proof).toBe('stays-green');
    await p.approve('GOAL-C1');
    await p.invoke('goal', 'select', 'GOAL-C1', ...human);
    await p.invoke('lead', 'propose', '--characterize', '--goal', 'GOAL-C1');
    expect(p.state('GOAL-C1')?.proposal).toMatchObject({ mode: 'solo-direct', paths: ['tests/**'] });
    await p.invoke('lead', 'commit', 'GOAL-C1');
    expect(p.state('GOAL-C1')?.status).toBe('testing');

    const map = JSON.stringify([
      { acceptanceId: 'AC-1', part: 'app', layer: 'L2', testIds: ['tests.acceptance.calc::add'] },
    ]);
    const mapPath = '.apos/goals/GOAL-C1/tests.json';
    // Red on the code as it is: refused, and nothing is locked.
    const red = p.commit({ 'tests/acceptance/calc.t': 'case add needs mul\n', [mapPath]: map }, 'wrong capture');
    p.out.length = 0;
    await p.invoke('tests', 'submit', 'GOAL-C1', '--commit', red);
    expect(process.exitCode).toBe(1);
    expect(p.out.join('\n')).toContain('chụp hành vi phải xanh trên code như hiện tại');
    process.exitCode = undefined;
    // Green: locked. Delivery is that commit: there is no code to write.
    const green = p.commit({ 'tests/acceptance/calc.t': 'case add needs add\n' }, 'capture add');
    p.out.length = 0;
    await p.invoke('tests', 'submit', 'GOAL-C1', '--commit', green);
    expect(p.state('GOAL-C1')?.testLock?.commit).toBe(green);
    p.out.length = 0;
    await p.invoke('package', 'submit', 'GOAL-C1', 'WP-MAIN', '--commit', green);
    expect(p.out.join('\n')).toContain('verified');
    await p.invoke('outcome', 'close', 'GOAL-C1', ...human);
    expect(p.state('GOAL-C1')?.status).toBe('closed');

    // A refactor must stay inside what is captured: src/other.txt is not.
    await p.invoke('goal', 'create', '--file', p.json('r.json', refactorGoal(['src/other.txt'])), '--source', p.brief);
    await expect(p.approve('GOAL-R1')).rejects.toThrow(/not covered by a closed characterize Goal: src\/other\.txt/);
    expect(p.state('GOAL-R1')?.status).toBe('draft');
    await p.invoke(
      'goal',
      'revise',
      '--file',
      p.json('r2.json', refactorGoal(['src/impl.txt', 'src/nowhere/**'], 2)),
      '--source',
      p.brief,
    );
    await expect(p.approve('GOAL-R1')).rejects.toThrow(/paths "src\/nowhere\/\*\*" matches no file/);
    await p.invoke(
      'goal',
      'revise',
      '--file',
      p.json('r3.json', refactorGoal(['src/impl.txt'], 3)),
      '--source',
      p.brief,
    );
    await p.approve('GOAL-R1');
    await p.invoke('goal', 'select', 'GOAL-R1', ...human);

    const base = p.git('rev-parse', 'HEAD');
    const plan = (paths: string[], version: number) =>
      p.json('plan.json', {
        id: 'EXEC-R1',
        version,
        goalId: 'GOAL-R1',
        goalVersion: 3,
        mode: 'solo-direct',
        approach: 'restructure impl',
        rationale: 'one owner',
        risks: [],
        baseCommit: base,
        paths,
        acceptanceMapping: [],
        verificationStrategy: 'the captured tests',
      });
    await p.invoke('lead', 'propose', '--file', plan(['src/**'], 1));
    await expect(p.invoke('lead', 'commit', 'GOAL-R1')).rejects.toThrow(
      /reaches past the Goal's paths.*src\/other\.txt/,
    );
    const fixed = plan(['src/impl.txt'], 2);
    await p.invoke('lead', 'propose', '--file', fixed);
    await p.invoke('lead', 'commit', 'GOAL-R1');
    expect(p.state('GOAL-R1')?.status).toBe('executing');

    // A refactor that changes what add does: the captured test goes red, and the gate says which.
    const broken = p.commit({ 'src/impl.txt': 'mul\n' }, 'refactor that breaks add');
    p.out.length = 0;
    await p.invoke('package', 'submit', 'GOAL-R1', 'WP-MAIN', '--commit', broken);
    expect(process.exitCode).toBe(1);
    expect(p.out.join('\n')).toMatch(/APOS-CHARACTERIZED fail: GOAL-C1: .*app\.L2 tests\.acceptance\.calc::add/);
    process.exitCode = undefined;
    // Deleting the captured test is red too: a captured test is locked like any other.
    p.git('rm', '-q', 'tests/acceptance/calc.t');
    p.git('commit', '-qm', 'drop the captured test');
    const dropped = p.git('rev-parse', 'HEAD');
    p.out.length = 0;
    await p.invoke('package', 'submit', 'GOAL-R1', 'WP-MAIN', '--commit', dropped);
    expect(process.exitCode).toBe(1);
    expect(p.out.join('\n')).toContain('locked test modified: tests/acceptance/calc.t (deleted)');
    process.exitCode = undefined;
    p.git('revert', '--no-edit', 'HEAD');
    // One that touches a file outside its paths is out of scope, as for any Goal.
    const stray = p.commit({ 'src/impl.txt': 'add\ntidied\n', 'src/other.txt': 'changed\n' }, 'refactor that strays');
    p.out.length = 0;
    await p.invoke('package', 'submit', 'GOAL-R1', 'WP-MAIN', '--commit', stray);
    expect(p.out.join('\n')).toContain('APOS-SCOPE');
    process.exitCode = undefined;
    // One that keeps add working is green, and the table says what was kept.
    const good = p.commit({ 'src/other.txt': 'other\n' }, 'put the stray file back');
    p.out.length = 0;
    await p.invoke('package', 'submit', 'GOAL-R1', 'WP-MAIN', '--commit', good);
    expect(p.out.join('\n')).toContain('verified');
    await p.invoke('outcome', 'close', 'GOAL-R1', ...human);
    expect(p.state('GOAL-R1')?.status).toBe('closed');
    expect(p.state('GOAL-R1')?.closeGate?.checks.map(item => item.checkId)).toContain('APOS-CHARACTERIZED');
    p.out.length = 0;
    await p.invoke('goal', 'show', 'GOAL-R1');
    expect(p.out.join('\n')).toMatch(
      /giữ nguyên hành vi: 1 test chụp từ GOAL-C1, xanh trước trên \w{7}, xanh sau trên \w{7}/,
    );
    expect(p.out.join('\n')).toContain('không có khoá test riêng');
    expect(buildSnapshot(new ReadOnlyJournal(p.home)).goals.length).toBe(2);
  }, 300_000);

  it('does not let a refactor be approved before a characterize Goal is closed', async () => {
    const p = await legacyRepo();
    await p.invoke('goal', 'create', '--file', p.json('r.json', refactorGoal(['src/impl.txt'])), '--source', p.brief);
    await expect(p.approve('GOAL-R1')).rejects.toThrow(/not covered by a closed characterize Goal: src\/impl\.txt/);
  }, 60_000);

  it('keeps the old rules: a feature Goal and the old plan flags are untouched', async () => {
    const p = await legacyRepo();
    await expect(p.invoke('lead', 'propose', '--characterize')).rejects.toThrow(/--characterize needs --goal/);
    await expect(p.invoke('lead', 'propose', '--characterize', '--bugfix', '--goal', 'x')).rejects.toThrow(
      /Give one of/,
    );
  }, 60_000);
});
