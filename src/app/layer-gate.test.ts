import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExceptionService } from './exceptions.js';
import { closeLayerProblems } from '../domain/close-gate.js';
import { spec } from '../domain/fixtures.test-support.js';
import type { GoalSpec } from '../domain/contracts.js';
import { cleanProjects, lockedProject, setupDocument } from './test-lock.test-support.js';

afterEach(cleanProjects);

/** Tools that read their answer from a file in the worktree, so each commit says what its tools report. */
const SARIF = `
const fs = require('fs');
const levels = fs.existsSync('src/findings.txt') ? fs.readFileSync('src/findings.txt', 'utf8').split(/\\s+/).filter(Boolean) : [];
const results = levels.map((level, i) => ({ ruleId: 'R' + i, level, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.py' }, region: { startLine: i + 1 } } }] }));
fs.writeFileSync(process.argv[2], JSON.stringify({ runs: [{ tool: { driver: { name: 't' } }, results }] }));
`;
/** Prints the next value of `values` (a comma list in `bench.txt`), counting in `counter`, a file outside the worktree. */
const METRIC = `
const fs = require('fs');
const [out, counter] = process.argv.slice(2);
const values = fs.readFileSync('src/bench.txt', 'utf8').trim().split(',').map(Number);
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
fs.writeFileSync(out, JSON.stringify({ p95_ms: values[n % values.length], throughput: 2000 }));
`;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const counterFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-metric-'));
  dirs.push(dir);
  return join(dir, 'counter').replaceAll('\\', '/');
};

type Over = {
  layers?: Record<string, unknown[]>;
  top?: object;
  files?: Record<string, string>;
  plan?: object;
  goal?: GoalSpec;
};
async function project(over: Over = {}) {
  const part = setupDocument.parts.app;
  const setup = {
    ...setupDocument,
    parts: { app: { ...part, layers: { ...part.layers, ...over.layers } } },
    ...over.top,
  };
  return lockedProject({
    setup,
    goal: over.goal,
    plan: over.plan,
    files: { 'sarif.js': SARIF, 'metric.js': METRIC, 'src/bench.txt': '100', ...over.files },
  });
}
const lint = (command: string) => ({ id: 'lint', command, format: 'exit' });
const gateOf = (p: Awaited<ReturnType<typeof project>>) => p.state().packages?.['WP-MAIN']?.gate;
const checkOf = (p: Awaited<ReturnType<typeof project>>, id: string) => gateOf(p)?.checks.find(c => c.checkId === id);
const work = { 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' };

describe('layers at the submit stage', () => {
  it('records what it planned and runs L1 and L2 of the changed part, one check per tool', async () => {
    const p = await project();
    expect((await p.submit(p.commit(work))).result).toBe('green');
    expect(gateOf(p)?.layers).toMatchObject({
      stage: 'submit',
      runs: [
        { part: 'app', layer: 'L1', tool: 'unit', why: 'floor' },
        { part: 'app', layer: 'L2', tool: 'acceptance', why: 'floor' },
      ],
      skipped: ['L0 không chạy ở khâu submit: setup không có công cụ cho lớp này'],
    });
  }, 120_000);

  it('L0 is an exit-code tool: red on a non-zero exit', async () => {
    const p = await project({ layers: { L0: [lint('node -e "process.exit(3)"')] } });
    const result = await p.submit(p.commit(work));
    expect(result.result).toBe('red');
    expect(checkOf(p, 'app.L0.lint')).toMatchObject({ status: 'fail', reason: 'app.L0 lint: exit 3' });
  }, 120_000);

  it('a floor layer in which no test ran is unverifiable and names the layer (review focus 1)', async () => {
    const p = await project({
      layers: { L1: [{ id: 'unit', command: 'node runner.js {report} tests/none', format: 'junit' }] },
    });
    const result = await p.submit(p.commit(work));
    expect(result.result).toBe('unverifiable');
    expect(result.reasons.join('\n')).toContain('app.L1 unit: no test ran');
  }, 120_000);

  it('a SARIF finding below failOn is not red, but its count is kept (review focus 4)', async () => {
    const p = await project({ layers: { L0: [{ id: 'scan', command: 'node sarif.js {report}', format: 'sarif' }] } });
    const result = await p.submit(p.commit({ ...work, 'src/findings.txt': 'warning note' }));
    expect(result.result).toBe('green');
    expect(checkOf(p, 'app.L0.scan')).toMatchObject({ status: 'pass', findings: { blocking: 0, lower: 2 } });
  }, 120_000);

  it('a SARIF finding at the blocking level is red, and failOn moves the line', async () => {
    const strict = await project({
      layers: { L0: [{ id: 'scan', command: 'node sarif.js {report}', format: 'sarif', failOn: 'warning' }] },
    });
    expect((await strict.submit(strict.commit({ ...work, 'src/findings.txt': 'warning' }))).result).toBe('red');
    const normal = await project({
      layers: { L0: [{ id: 'scan', command: 'node sarif.js {report}', format: 'sarif' }] },
    });
    const result = await normal.submit(normal.commit({ ...work, 'src/findings.txt': 'error' }));
    expect(result.result).toBe('red');
    expect(result.reasons.join('\n')).toContain('1 finding(s) at error or above');
  }, 240_000);

  it('with two tools in one layer a locked test that vanishes from its own tool is red, whatever the other tool reports', async () => {
    const second = { id: 'extra', command: 'node runner.js {report} tests/extra', format: 'junit' };
    const first = setupDocument.parts.app.layers.L2[0]!;
    const p = await project({
      layers: { L2: [first, second] },
      files: { 'tests/extra/x.t': 'case x pass\n', 'tests/acceptance/keep.t': 'case keep pass\n' },
    });
    // The locked test is edited out of its file (the file's own lock check is APOS-LOCKED's); the layer check says it is gone.
    const result = await p.submit(p.commit({ ...work, 'tests/acceptance/calc.t': 'case other pass\n' }));
    expect(result.result).toBe('red');
    expect(checkOf(p, 'app.L2.acceptance')).toMatchObject({ status: 'fail' });
    expect(checkOf(p, 'app.L2.acceptance')?.reason).toContain(
      'locked test tests.acceptance.calc::add is not in the report',
    );
    expect(checkOf(p, 'app.L2.extra')?.status).toBe('pass');
  }, 120_000);

  it('a layer the Lead adds runs at submit and is judged like the floor', async () => {
    const p = await project({
      layers: { L3: [lint('node -e "process.exit(0)"')] },
      plan: { layers: { submit: ['L3'] } },
    });
    expect((await p.submit(p.commit(work))).result).toBe('green');
    expect(gateOf(p)?.layers?.runs).toContainEqual(
      expect.objectContaining({ part: 'app', layer: 'L3', tool: 'lint', why: 'lead' }),
    );
    expect(checkOf(p, 'app.L3.lint')?.status).toBe('pass');
  }, 120_000);

  it('a trigger on a changed file pulls a layer in at submit, and says why', async () => {
    const p = await project({
      layers: { L4: [lint('node -e "process.exit(0)"')] },
      top: { triggers: [{ when: { changed: ['src/ui/**'] }, at: 'submit', run: ['app.L4'] }] },
      plan: { paths: ['src/**', 'tests/unit/**'] },
    });
    expect((await p.submit(p.commit({ ...work, 'src/ui/page.txt': 'x\n' }))).result).toBe('green');
    expect(gateOf(p)?.layers?.runs).toContainEqual(
      expect.objectContaining({ part: 'app', layer: 'L4', tool: 'lint', why: 'trigger' }),
    );
  }, 120_000);

  it('a floor layer cut by an approved exception is not run, is kept in the plan as reduced, and the cut is by log order', async () => {
    const p = await project({ layers: { L0: [lint('node -e "process.exit(3)"')] } });
    const first = await p.submit(p.commit(work, 'first'));
    expect(first.result).toBe('red');
    new ExceptionService(p.journal, p.loadSetup).approve(p.goalId, {
      kind: 'floor-reduced',
      ref: 'WP-MAIN:submit:L0',
      reason: 'lint is broken upstream',
      by: 'agent:lead',
    });
    expect(gateOf(p)?.layers?.runs.find(run => run.layer === 'L0')).not.toHaveProperty('reduced');
    const second = await p.submit(p.commit({ 'src/more.txt': 'y\n' }, 'again'));
    expect(second.result).toBe('green');
    expect(gateOf(p)?.layers?.runs).toContainEqual(
      expect.objectContaining({
        part: 'app',
        layer: 'L0',
        tool: 'lint',
        why: 'floor',
        reduced: true,
      }),
    );
    expect(checkOf(p, 'app.L0.lint')).toBeUndefined();
  }, 240_000);

  const benchTool = (threshold: { op: string; value: number }) => ({
    id: 'bench',
    command: `node metric.js {report} ${counterFile()}`,
    format: 'metric',
    metric: 'p95_ms',
    threshold,
  });
  it('a metric tool is measured three times and judged against its threshold: all inside passes', async () => {
    const p = await project({ layers: { L0: [benchTool({ op: '<', value: 200 })] } });
    expect((await p.submit(p.commit({ ...work, 'src/bench.txt': '150,160,170' }))).result).toBe('green');
    expect(checkOf(p, 'app.L0.bench')).toMatchObject({ status: 'pass', metric: { name: 'p95_ms', value: 160 } });
  }, 120_000);
  it('runs on both sides of the threshold are unverifiable: never the best run (review focus 3)', async () => {
    const p = await project({ layers: { L0: [benchTool({ op: '<', value: 200 })] } });
    const mixed = await p.submit(p.commit({ ...work, 'src/bench.txt': '150,250,160' }));
    expect(mixed.result).toBe('unverifiable');
    expect(mixed.reasons.join('\n')).toContain('runs disagree around the threshold (150, 250, 160)');
  }, 120_000);

  it('runs a test layer as many times as the setup says, and flaky results are unverifiable', async () => {
    const counter = counterFile();
    const flaky = `
const fs = require('fs');
const [out, counter] = process.argv.slice(2);
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
const bad = n % 2 === 1 ? '<failure message="AssertionError: flaky"/>' : '';
fs.writeFileSync(out, '<testsuite name="s"><testcase classname="tests.unit.flaky" name="f">' + bad + '</testcase></testsuite>');
`;
    const p = await project({
      layers: { L1: [{ id: 'unit', command: `node flaky.js {report} ${counter}`, format: 'junit', runs: 2 }] },
      files: { 'flaky.js': flaky },
    });
    const result = await p.submit(p.commit(work));
    expect(result.result).toBe('unverifiable');
    expect(result.reasons.join('\n')).toContain('runs disagree');
    expect(existsSync(counter) && Number(readFileSync(counter, 'utf8')) >= 2).toBe(true);
  }, 240_000);
});

describe('layers at the close stage', () => {
  const verified = async (over: Over = {}) => {
    const p = await project(over);
    expect((await p.submit(p.commit(work))).result).toBe('green');
    expect(p.state().status).toBe('verified');
    return p;
  };
  it('runs the whole floor on the verified commit, once more, and records it as its own gate', async () => {
    const p = await verified({ layers: { L3: [lint('node -e "process.exit(0)"')] } });
    const report = p.gate.runClose(p.goalId, p.dir);
    expect(report).toMatchObject({ phase: 'close', result: 'green', deliveryCommit: p.state().verifiedCommit });
    expect(report?.checks.map(check => check.checkId)).toEqual(['app.L1.unit', 'app.L2.acceptance', 'app.L3.lint']);
    expect(p.state().closeGate?.gateId).toBe(report?.gateId);
    expect(closeLayerProblems(p.state())).toEqual([]);
  }, 120_000);
  it('a layer that only the close floor has can fail there, and the close is refused with its name', async () => {
    const p = await verified({ layers: { L3: [lint('node -e "process.exit(7)"')] } });
    expect(p.gate.runClose(p.goalId, p.dir)?.result).toBe('red');
    expect(closeLayerProblems(p.state()).join('\n')).toMatch(/app\.L3\.lint fail: app\.L3 lint: exit 7/);
  }, 120_000);
  it('an approved exception on <goal>:close:<layer> lets the same commit close', async () => {
    const p = await verified({ layers: { L3: [lint('node -e "process.exit(7)"')] } });
    p.gate.runClose(p.goalId, p.dir);
    new ExceptionService(p.journal, p.loadSetup).approve(p.goalId, {
      kind: 'floor-reduced',
      ref: `${p.goalId}:close:L3`,
      reason: 'integration env is down',
      by: 'agent:lead',
    });
    expect(p.gate.runClose(p.goalId, p.dir)?.result).toBe('green');
    expect(closeLayerProblems(p.state())).toEqual([]);
    expect(p.state().closeGate?.layers?.runs).toContainEqual(
      expect.objectContaining({
        part: 'app',
        layer: 'L3',
        tool: 'lint',
        why: 'floor',
        reduced: true,
      }),
    );
  }, 120_000);
  it('asks for nothing of a Goal that has no setup, and refuses to close one whose layers never ran', async () => {
    const p = await verified();
    expect(closeLayerProblems(p.state())[0]).toMatch(/have not run on/);
    expect(closeLayerProblems({ ...p.state(), setupVersion: undefined })).toEqual([]);
  }, 120_000);
});

describe("non-functional criteria (the thresholds are the Goal's)", () => {
  const goalWith = (extra: object): GoalSpec => ({
    ...spec,
    checks: [{ ...spec.checks[0]!, command: 'node -e "process.exit(0)"' }],
    acceptance: [spec.acceptance[0]!, { ...spec.acceptance[0]!, id: 'AC-2', checkIds: [], ...extra }],
  });
  const benchGoal = goalWith({
    proof: 'benchmark',
    benchmark: { tool: 'app.L5.bench', metric: 'p95_ms', op: '<', value: 200 },
  });
  const bench = () => ({ id: 'bench', command: `node metric.js {report} ${counterFile()}`, format: 'metric' });
  const closeOnly = { floor: { close: ['L1'] } };
  const closeWith = async (over: Over, files: Record<string, string>) => {
    const p = await project(over);
    expect((await p.submit(p.commit({ ...work, ...files }))).result).toBe('green');
    return { p, report: p.gate.runClose(p.goalId, p.dir) };
  };

  it('a benchmark criterion runs its tool at close even when the floor does not, and passes inside the Goal threshold', async () => {
    const { p, report } = await closeWith(
      { goal: benchGoal, layers: { L5: [bench()] }, top: closeOnly },
      { 'src/bench.txt': '150,160,170' },
    );
    expect(report?.result).toBe('green');
    expect(p.state().closeGate?.layers?.runs).toContainEqual(
      expect.objectContaining({ part: 'app', layer: 'L5', tool: 'bench', why: 'proof' }),
    );
    expect(report?.checks.find(check => check.checkId === 'app.L5.bench')).toMatchObject({
      status: 'pass',
      metric: { name: 'p95_ms', value: 160 },
    });
  }, 120_000);
  it('fails when the measurement is outside the threshold the Goal set, though the setup has none', async () => {
    const { report } = await closeWith(
      { goal: benchGoal, layers: { L5: [bench()] }, top: closeOnly },
      { 'src/bench.txt': '250,260,240' },
    );
    expect(report?.result).toBe('red');
    expect(report?.checks.find(check => check.checkId === 'app.L5.bench')?.reason).toContain(
      'p95_ms < 200 does not hold',
    );
  }, 120_000);
  it('a setup threshold cannot loosen the Goal: both must hold', async () => {
    const loose = { ...bench(), threshold: { op: '<', value: 1000 } };
    const { report } = await closeWith(
      { goal: benchGoal, layers: { L5: [loose] }, top: closeOnly },
      { 'src/bench.txt': '250,260,240' },
    );
    expect(report?.result).toBe('red');
  }, 120_000);
  it("a criterion on another metric is judged by its own numbers; the setup's threshold stays on the tool's own metric", async () => {
    const goal = goalWith({
      proof: 'benchmark',
      benchmark: { tool: 'app.L5.bench', metric: 'throughput', op: '>', value: 1000 },
    });
    const tool = { ...bench(), metric: 'p95_ms', threshold: { op: '<', value: 200 } };
    const { report } = await closeWith(
      { goal, layers: { L5: [tool] }, top: closeOnly },
      { 'src/bench.txt': '150,150,150' },
    );
    expect(report?.result).toBe('green');
    expect(
      report?.checks.filter(check => check.checkId.startsWith('app.L5.bench')).map(check => check.checkId),
    ).toEqual(['app.L5.bench', 'app.L5.bench:throughput']);
    expect(report?.checks.find(check => check.checkId === 'app.L5.bench:throughput')).toMatchObject({
      status: 'pass',
      metric: { name: 'throughput', value: 2000 },
    });
    const slow = await closeWith({ goal, layers: { L5: [tool] }, top: closeOnly }, { 'src/bench.txt': '250,250,250' });
    expect(slow.report?.result).toBe('red');
    expect(slow.report?.checks.find(check => check.checkId === 'app.L5.bench')?.status).toBe('fail');
    expect(slow.report?.checks.find(check => check.checkId === 'app.L5.bench:throughput')?.status).toBe('pass');
  }, 240_000);
  it('a scan criterion makes the tool block from the level the Goal names', async () => {
    const goal = goalWith({ proof: 'scan', scan: { tool: 'app.L5.scan', failOn: 'warning' } });
    const scan = { id: 'scan', command: 'node sarif.js {report}', format: 'sarif' };
    const { report } = await closeWith(
      { goal, layers: { L5: [scan] }, top: closeOnly },
      { 'src/findings.txt': 'warning' },
    );
    expect(report?.result).toBe('red');
    expect(report?.checks.find(check => check.checkId === 'app.L5.scan')).toMatchObject({
      findings: { blocking: 1, lower: 0 },
    });
  }, 120_000);
  it('a scan with only lower findings is green and shows the count', async () => {
    const goal = goalWith({ proof: 'scan', scan: { tool: 'app.L5.scan', failOn: 'error' } });
    const scan = { id: 'scan', command: 'node sarif.js {report}', format: 'sarif' };
    const { report } = await closeWith(
      { goal, layers: { L5: [scan] }, top: closeOnly },
      { 'src/findings.txt': 'warning note' },
    );
    expect(report?.result).toBe('green');
    expect(report?.checks.find(check => check.checkId === 'app.L5.scan')).toMatchObject({
      findings: { blocking: 0, lower: 2 },
    });
  }, 120_000);
});
