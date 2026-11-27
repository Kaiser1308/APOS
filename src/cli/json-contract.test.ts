import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testingProject, lockedProject, cleanProjects, goodTests } from '../app/test-lock.test-support.js';
import { approval, proposal, sourceText, spec } from '../domain/fixtures.test-support.js';
import { initProject } from '../app/init-project.js';
import { newEvent } from '../app/events.js';
import { ProjectJournal } from '../store/journal.js';
import { controllerHome } from '../store/event-log.js';

const root = resolve('.');
const homeRoot = mkdtempSync(join(tmpdir(), 'apos-cli-contract-'));
beforeAll(() => execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { cwd: root }), 60_000);
afterAll(() => {
  cleanProjects();
  rmSync(homeRoot, { recursive: true, force: true });
});

it('validates real CLI snapshots and a resumable event stream against the published schemas', async () => {
  const p = await testingProject({
    goal: {
      ...spec,
      checks: [{ ...spec.checks[0]!, command: "node -e \"process.exit(require('fs').existsSync('post-red')?1:0)\"" }],
    },
  });
  const bad = p.commit({ ...goodTests(p.goalId), 'tests/acceptance/calc.t': 'case add pass\n' }, 'bad tests');
  p.close();
  const target = controllerHome(p.dir, homeRoot);
  mkdirSync(target, { recursive: true });
  cpSync(p.home, target, { recursive: true });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(root, 'dist/cli.js'), '--repo', p.dir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, APOS_HOME: homeRoot },
    });
  const ajv = new Ajv();
  const resultSchema: unknown = JSON.parse(readFileSync(join(root, 'schemas/result-v1.schema.json'), 'utf8'));
  const eventSchema: unknown = JSON.parse(readFileSync(join(root, 'schemas/events-v1.schema.json'), 'utf8'));
  const result = ajv.compile(resultSchema as object);
  const event = ajv.compile(eventSchema as object);
  const goal = run('goal', 'show', p.goalId, '--json');
  expect(goal.status).toBe(3);
  expect(JSON.parse(goal.stdout).verdict).toBe('unverifiable');
  expect(result(JSON.parse(goal.stdout))).toBe(true);
  const inbox = run('inbox', '--json');
  expect(inbox.status).toBe(3);
  expect(JSON.parse(inbox.stdout).verdict).toBe('unverifiable');
  expect(result(JSON.parse(inbox.stdout))).toBe(true);
  const refused = run('tests', 'submit', p.goalId, '--commit', bad, '--json');
  expect(refused.status).toBe(1);
  expect(result(JSON.parse(refused.stdout))).toBe(true);
  expect(JSON.parse(refused.stdout).verdict).toBe('red');
  const good = p.commit(goodTests(p.goalId), 'good tests');
  const locked = run('tests', 'submit', p.goalId, '--commit', good, '--json');
  expect(locked.status).toBe(0);
  expect(result(JSON.parse(locked.stdout))).toBe(true);
  expect(JSON.parse(locked.stdout).verdict).toBe('green');
  const sensitive = p.commit({ 'src/impl.txt': 'add\n', 'pyproject.toml': '[project]\n' }, 'sensitive delivery');
  const human = run('package', 'submit', p.goalId, 'WP-MAIN', '--commit', sensitive, '--json');
  expect(human.status, human.stdout + human.stderr).toBe(3);
  expect(result(JSON.parse(human.stdout))).toBe(true);
  expect(JSON.parse(human.stdout).verdict).toBe('needs-human');
  const delivery = p.commit({ 'pyproject.toml': null }, 'delivery');
  const submitted = run('package', 'submit', p.goalId, 'WP-MAIN', '--commit', delivery, '--json');
  expect(submitted.status, submitted.stdout + submitted.stderr).toBe(0);
  expect(result(JSON.parse(submitted.stdout))).toBe(true);
  expect(JSON.parse(submitted.stdout).verdict).toBe('green');
  const missing = run('events', '--since', '0', '--json');
  expect(missing.status).toBe(1);
  const first = run('events', '--since', '0', '--json', '--initialize');
  expect(first.status).toBe(0);
  const stream = JSON.parse(first.stdout) as {
    generation: string;
    anchor: string;
    events: { seq: number; id: string; anchor: string }[];
  };
  expect(event(stream)).toBe(true);
  const midpoint = stream.events[Math.floor(stream.events.length / 2)]!;
  const partial = run(
    'events',
    '--since',
    String(midpoint.seq),
    '--generation',
    stream.generation,
    '--anchor',
    midpoint.anchor,
    '--json',
  );
  expect(partial.status).toBe(0);
  expect((JSON.parse(partial.stdout) as { events: { id: string }[] }).events.map(item => item.id)).toEqual(
    stream.events.filter(item => item.seq > midpoint.seq).map(item => item.id),
  );
  const last = stream.events.at(-1)?.seq ?? 0;
  const resumed = run(
    'events',
    '--since',
    String(last),
    '--generation',
    stream.generation,
    '--anchor',
    stream.anchor,
    '--json',
  );
  expect(resumed.status).toBe(0);
  expect(JSON.parse(resumed.stdout).events).toEqual([]);
  const asyncRun = promisify(execFile);
  const env = { ...process.env, APOS_HOME: homeRoot };
  await Promise.all([
    ...Array.from({ length: 4 }, (_, i) =>
      asyncRun(
        process.execPath,
        [join(root, 'dist/cli.js'), '--repo', p.dir, 'decision', 'record', p.goalId, '--note', `parallel ${i}`],
        { env },
      ),
    ),
    ...Array.from({ length: 3 }, () =>
      asyncRun(
        process.execPath,
        [
          join(root, 'dist/cli.js'),
          '--repo',
          p.dir,
          'events',
          '--since',
          String(last),
          '--generation',
          stream.generation,
          '--anchor',
          stream.anchor,
          '--json',
        ],
        { env },
      ),
    ),
  ]);
  const after = run(
    'events',
    '--since',
    String(last),
    '--generation',
    stream.generation,
    '--anchor',
    stream.anchor,
    '--json',
  );
  expect(after.status).toBe(0);
  const events = (JSON.parse(after.stdout) as { events: { seq: number; id: string }[] }).events;
  expect(events).toHaveLength(4);
  expect(events.map(item => item.seq)).toEqual([last + 1, last + 2, last + 3, last + 4]);
  expect(new Set(events.map(item => item.id)).size).toBe(4);
  p.git('checkout', '-qb', 'target', good);
  const targetHead = p.commit({ 'post-red': 'break post-merge gate' }, 'target diverged');
  const failed = run('outcome', 'close', p.goalId, '--merge-to', 'target', '--on-behalf', 'contract test', '--json');
  expect(failed.status, failed.stderr).toBe(1);
  const closeResult = JSON.parse(failed.stdout) as {
    status: string;
    merge: { mergeCommit: string; targetBranch: string };
  };
  expect(result(closeResult)).toBe(true);
  expect(closeResult.status).toBe('verified');
  expect(closeResult.merge.targetBranch).toBe('target');
  expect(p.git('rev-parse', `${closeResult.merge.mergeCommit}^1`)).toBe(targetHead);
  expect(p.git('rev-parse', `${closeResult.merge.mergeCommit}^2`)).toBe(delivery);
  const retried = run('outcome', 'close', p.goalId, '--on-behalf', 'contract test', '--json');
  expect(retried.status).toBe(1);
  expect(JSON.parse(retried.stdout).merge.mergeCommit).toBe(closeResult.merge.mergeCommit);
}, 60_000);

it('validates an integration gate produced by the real CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-multi-cli-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    await initProject(dir);
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', 'add', '-A']);
    execFileSync('git', [
      '-C',
      dir,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@local.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'base',
    ]);
    const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const goal = {
      ...spec,
      checks: [{ id: 'CHK-1', kind: 'manual' as const, procedure: 'Inspect the result', expectedResult: 'Approved' }],
    };
    const { journal, close } = ProjectJournal.open(dir, controllerHome(dir, homeRoot), newEvent);
    journal.appendWithSource(newEvent(goal.id, 'goal-drafted', goal), sourceText);
    journal.append(newEvent(goal.id, 'goal-approved', approval));
    journal.append(newEvent(goal.id, 'goal-selected'));
    journal.append(newEvent(goal.id, 'proposal-drafted', { ...proposal, mode: 'multi-wp', baseCommit: base }));
    const pkg = {
      id: 'WP-01',
      goalId: goal.id,
      goalVersion: 1,
      version: 1,
      owner: 'worker',
      outcome: 'one',
      scope: ['one'],
      exclusions: [],
      dependencies: [],
      interfaces: ['api@v1'],
      acceptance: [{ id: 'WP-AC-1', text: 'works', goalAcceptanceId: 'AC-1' }],
      integration: 'integrate',
    };
    journal.append(newEvent(goal.id, 'package-added', pkg));
    journal.append(
      newEvent(goal.id, 'package-added', {
        ...pkg,
        id: 'WP-02',
        outcome: 'two',
        scope: ['two'],
        acceptance: [{ id: 'WP-AC-2', text: 'other' }],
      }),
    );
    journal.append(newEvent(goal.id, 'proposal-approved'));
    close();
    const output = spawnSync(
      process.execPath,
      [
        join(root, 'dist/cli.js'),
        '--repo',
        dir,
        'integration',
        'gate',
        goal.id,
        '--commit',
        base,
        '--reason',
        'contract test',
        '--json',
      ],
      { encoding: 'utf8', env: { ...process.env, APOS_HOME: homeRoot } },
    );
    expect([0, 1, 3], output.stderr).toContain(output.status);
    const value = JSON.parse(output.stdout) as { verdict: string };
    const schema: object = JSON.parse(readFileSync(join(root, 'schemas/result-v1.schema.json'), 'utf8'));
    expect(new Ajv().validate(schema, value)).toBe(true);
    expect(value.verdict).toBe('unverifiable');
    expect(output.status).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it('reports the merge and closed status after a successful real CLI close', async () => {
  const p = await lockedProject();
  const delivery = p.commit({ 'src/impl.txt': 'add\n' }, 'delivery');
  expect((await p.submit(delivery)).result).toBe('green');
  p.git('checkout', '-qb', 'target', p.lockCommit);
  const targetHead = p.commit({ 'independent.txt': 'target change' }, 'target diverged');
  p.close();
  const target = controllerHome(p.dir, homeRoot);
  mkdirSync(target, { recursive: true });
  cpSync(p.home, target, { recursive: true });
  const closed = spawnSync(
    process.execPath,
    [
      join(root, 'dist/cli.js'),
      '--repo',
      p.dir,
      'outcome',
      'close',
      p.goalId,
      '--merge-to',
      'target',
      '--on-behalf',
      'contract test',
      '--json',
    ],
    { encoding: 'utf8', env: { ...process.env, APOS_HOME: homeRoot } },
  );
  expect([0, 3], closed.stderr).toContain(closed.status);
  const value = JSON.parse(closed.stdout) as { status: string; merge: { mergeCommit: string; targetBranch: string } };
  const schema: object = JSON.parse(readFileSync(join(root, 'schemas/result-v1.schema.json'), 'utf8'));
  expect(new Ajv().validate(schema, value)).toBe(true);
  expect(value.status).toBe('closed');
  expect(value.merge.targetBranch).toBe('target');
  expect(p.git('rev-parse', `${value.merge.mergeCommit}^1`)).toBe(targetHead);
  expect(p.git('rev-parse', `${value.merge.mergeCommit}^2`)).toBe(delivery);
}, 60_000);
