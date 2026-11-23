import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceDigest } from '../domain/gate.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goalKind } from '../domain/contracts.js';
import { removeTemp, temp } from './bug.test-support.js';
import { maintProject, manifest } from './maintenance.test-support.js';

const saved = process.env.APOS_HOME;
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-maint-home-');
});
afterEach(() => {
  process.exitCode = undefined;
  delete process.env.APOS_FLAKY;
  delete process.env.APOS_SCAN_LOG;
  delete process.env.APOS_SCAN_FLAKY;
  delete process.env.APOS_SCAN_SEVERITY;
  if (saved === undefined) delete process.env.APOS_HOME;
  else process.env.APOS_HOME = saved;
  removeTemp();
});

describe('apos maintenance open', () => {
  it('drafts a Solo maintenance Goal with no criterion, its source hashed, and the base scan recorded once', async () => {
    const p = await maintProject();
    await p.invoke('maintenance', 'open', 'Bump fmt to 1.1.0', '--security', 'CVE-FMT-1', '--paths', 'src/**');
    const goal = p.state('GOAL-MAINT-001')!;
    expect(goalKind(goal.spec)).toBe('maintenance');
    expect(goal.status).toBe('draft');
    expect(goal.spec.acceptance).toEqual([]);
    expect(goal.spec.paths).toEqual(['src/**']);
    expect(goal.spec.security).toHaveLength(1);
    expect(goal.spec.baseline?.commit).toBe(p.head());
    const found = goal.spec.baseline?.scans[0]?.findings.map(item => item.ruleId).sort();
    expect(found).toEqual(['CVE-FMT-1', 'OLD-1']);
    expect(goal.spec.security![0]).toBe(
      goal.spec.baseline?.scans[0]?.findings.find(item => item.ruleId === 'CVE-FMT-1')?.fingerprint,
    );
    expect(p.out.join('\n')).toContain('apos maintenance approve GOAL-MAINT-001');
  });

  it('refuses a finding the base does not show, and a ruleId that matches nothing', async () => {
    const p = await maintProject({ deps: { fmt: '1.1.0' } });
    await expect(p.invoke('maintenance', 'open', 'x', '--security', 'CVE-FMT-1')).rejects.toThrow(
      /không tái hiện được finding trên base/,
    );
    expect(p.state('GOAL-MAINT-001')).toBeUndefined();
  });

  it('refuses a security Goal when the setup has no scan tool, but opens a plain one', async () => {
    const p = await maintProject({ scan: false });
    await expect(p.invoke('maintenance', 'open', 'x', '--security', 'CVE-FMT-1')).rejects.toThrow(/no scan tool/);
    await p.invoke('maintenance', 'open', 'Bump fmt');
    expect(p.state('GOAL-MAINT-001')!.spec.baseline).toBeUndefined();
  });

  it('needs an approved setup and a description', async () => {
    const p = await maintProject();
    await expect(p.invoke('maintenance', 'open')).rejects.toThrow(/description/);
  });
});

describe('apos maintenance approve', () => {
  it('approves, sets the default appetite and selects with one confirmation', async () => {
    const p = await maintProject();
    await p.invoke('maintenance', 'open', 'Bump fmt');
    await expect(p.invoke('maintenance', 'approve', 'GOAL-MAINT-001')).rejects.toThrow(/terminal|on-behalf/i);
    expect(p.state('GOAL-MAINT-001')!.status).toBe('draft');
    await p.invoke('maintenance', 'approve', 'GOAL-MAINT-001', '--on-behalf', 'item 1');
    const goal = p.state('GOAL-MAINT-001')!;
    expect(goal.status).toBe('selected');
    expect(goal.appetite).toMatchObject({ size: 'S', maxWallMinutes: 60, maxAttempts: 3 });
    expect(goal.maintenanceApproval).toEqual({ by: 'on-behalf', onBehalf: 'item 1' });
    const via = p.events('GOAL-MAINT-001').flatMap(event => {
      const data = event.data as { via?: string } | undefined;
      return data?.via ? [`${event.type}:${data.via}`] : [];
    });
    expect(via).toEqual([
      'goal-approved:maintenance approve',
      'appetite-set:maintenance approve',
      'goal-selected:maintenance approve',
    ]);
  });

  it('refuses a Goal that is not a maintenance Goal', async () => {
    const p = await maintProject();
    await p.invoke('bug', 'open', 'x', '--given', 'a', '--when', 'b', '--then', 'c');
    await expect(p.invoke('maintenance', 'approve', 'GOAL-BUG-001', '--on-behalf', 'x')).rejects.toThrow(
      /not a maintenance Goal/,
    );
  });

  it('refuses a security Goal when the setup has no scan tool, or the base never showed the finding', async () => {
    const p = await maintProject({ scan: false });
    const goal = (extra: Record<string, unknown>) => ({
      id: 'GOAL-MAINT-009',
      version: 1,
      kind: 'maintenance',
      outcome: 'patch',
      source: {
        path: 'brief.md',
        sha256: sourceDigest('brief\n'),
        capturedAt: '2026-01-01T00:00:00Z',
        origin: 'human',
      },
      requirements: [{ id: 'R-1', sourceSpan: 'brief', text: 'patch', disposition: 'acceptance' }],
      scope: ['deps'],
      security: ['h:abc'],
      ...extra,
    });
    writeFileSync(join(p.dir, 'goal.json'), JSON.stringify(goal({})));
    writeFileSync(join(p.dir, 'brief.md'), 'brief\n');
    await p.invoke('goal', 'create', '--file', join(p.dir, 'goal.json'), '--source', join(p.dir, 'brief.md'));
    await expect(p.invoke('maintenance', 'approve', 'GOAL-MAINT-009', '--on-behalf', 'x')).rejects.toThrow(
      /no scan tool/,
    );
    expect(p.state('GOAL-MAINT-009')!.status).toBe('draft');
    await expect(
      p.invoke(
        'goal',
        'approve',
        'GOAL-MAINT-009',
        '--size',
        'S',
        '--max-minutes',
        '60',
        '--max-attempts',
        '3',
        '--on-behalf',
        'x',
      ),
    ).rejects.toThrow(/no scan tool/);
    expect(p.state('GOAL-MAINT-009')!.status).toBe('draft');
  });
});

describe('what the Goal may change cannot be widened by the plan or the setup', () => {
  it('refuses to approve a Goal when the setup lists no manifests: there would be nothing to hold the change to', async () => {
    const p = await maintProject({ manifests: false });
    await p.invoke('maintenance', 'open', 'Bump fmt');
    await expect(p.invoke('maintenance', 'approve', 'GOAL-MAINT-001', '--on-behalf', 'x')).rejects.toThrow(
      /lists no manifests/,
    );
    expect(p.state('GOAL-MAINT-001')!.status).toBe('draft');
  });

  it('refuses a plan that names stub paths: a maintenance Goal has no Tester, and they would widen what it may change', async () => {
    const p = await maintProject();
    await p.invoke('maintenance', 'open', 'Bump fmt');
    await p.invoke('maintenance', 'approve', 'GOAL-MAINT-001', '--on-behalf', 'x');
    await p.invoke('lead', 'propose', '--maintenance', '--goal', 'GOAL-MAINT-001');
    const plan = { ...p.state('GOAL-MAINT-001')!.proposal!, stubPaths: ['src/**'], version: 2 };
    writeFileSync(join(p.dir, 'plan.json'), JSON.stringify(plan));
    await p.invoke('lead', 'propose', '--file', join(p.dir, 'plan.json'));
    await expect(p.invoke('lead', 'commit', 'GOAL-MAINT-001')).rejects.toThrow(/no Tester and no stub/);
    expect(p.state('GOAL-MAINT-001')!.status).toBe('planned');
  });
});

describe('the gate of a maintenance Goal', () => {
  const prepare = async (options: Parameters<typeof maintProject>[0] = {}, openArgs: string[] = []) => {
    const p = await maintProject(options);
    await p.invoke('maintenance', 'open', 'Bump fmt', ...openArgs);
    await p.invoke('maintenance', 'approve', 'GOAL-MAINT-001', '--on-behalf', 'item 1');
    await p.invoke('lead', 'propose', '--maintenance', '--goal', 'GOAL-MAINT-001');
    await p.invoke('lead', 'commit', 'GOAL-MAINT-001');
    return p;
  };
  const submit = async (p: Awaited<ReturnType<typeof prepare>>, sha: string) => {
    p.out.length = 0;
    process.exitCode = undefined;
    await p.invoke('package', 'submit', 'GOAL-MAINT-001', 'WP-MAIN', '--commit', sha);
    const code = process.exitCode as number | undefined;
    process.exitCode = undefined;
    return { code, text: p.out.join('\n') };
  };

  it('plans one Solo package whose paths are the manifests and the declared paths, with no Tester', async () => {
    const p = await prepare({}, ['--paths', 'src/**']);
    const goal = p.state('GOAL-MAINT-001')!;
    expect(goal.status).toBe('executing');
    expect(goal.proposal?.paths).toEqual(['deps.json', 'src/**']);
    expect(goal.packages?.['WP-MAIN']).toBeDefined();
  });

  it('is red on a new failure, and names the test', async () => {
    const p = await prepare();
    const sha = p.commitFiles('bump to 2', { 'deps.json': manifest({ fmt: '2.0.0' }) });
    const got = await submit(p, sha);
    expect(got.code).toBe(1);
    expect(got.text).toMatch(/new failure\(s\) vs the base: s::fmt-api/);
  });

  it('does not count a failure the base already had, and says how many', async () => {
    const p = await prepare({ legacy: true });
    const sha = p.commitFiles('bump to 1.1', { 'deps.json': manifest({ fmt: '1.1.0' }) });
    const got = await submit(p, sha);
    expect(got.code).toBe(0);
    const table = (await p.invoke('goal', 'show', 'GOAL-MAINT-001'), p.out.join('\n'));
    expect(table).toContain('lỗi có sẵn trên base: 1; lỗi mới: 0');
  });

  it('is red when a file outside the manifests and the declared paths changes, and names it', async () => {
    const p = await prepare();
    const sha = p.commitFiles('bump and touch src', {
      'deps.json': manifest({ fmt: '1.1.0' }),
      'src/app.js': 'module.exports = 2;\n',
    });
    const got = await submit(p, sha);
    expect(got.code).toBe(1);
    expect(got.text).toMatch(/outside the package paths.*src\/app\.js/);
  });

  it('is red on a new blocking finding, and counts one below the blocking level', async () => {
    const p = await prepare();
    const bad = p.commitFiles('adds a finding', { 'deps.json': manifest({ fmt: '1.0.0', extra: 'error' }) });
    const red = await submit(p, bad);
    expect(red.code).toBe(1);
    expect(red.text).toMatch(/1 new finding\(s\) vs the base at error or above: NEW-1/);
    const mild = p.commitFiles('mild finding', { 'deps.json': manifest({ fmt: '1.0.0', extra: 'note' }) });
    const green = await submit(p, mild);
    expect(green.code).toBe(0);
    await p.invoke('goal', 'show', 'GOAL-MAINT-001');
    expect(p.out.join('\n')).toContain('finding mới 0 (dưới mức chặn: 1)');
  });

  it('a security patch is green only when the named finding is gone, and the table says so', async () => {
    const p = await prepare({}, ['--security', 'CVE-FMT-1']);
    const base = p.state('GOAL-MAINT-001')!.proposal!.baseCommit!;
    const kept = p.commitFiles('no real fix', { 'deps.json': manifest({ fmt: '1.0.0', note: 'x' }) });
    const red = await submit(p, kept);
    expect(red.code).toBe(1);
    expect(red.text).toMatch(/APOS-SECURITY fail: finding vẫn còn trên commit giao/);
    const fixed = p.commitFiles('bump', { 'deps.json': manifest({ fmt: '1.1.0' }) });
    const green = await submit(p, fixed);
    expect(green.code).toBe(0);
    await p.invoke('goal', 'show', 'GOAL-MAINT-001');
    const text = p.out.join('\n');
    expect(text).toContain(`có trên ${base.slice(0, 7)}, không còn trên ${fixed.slice(0, 7)}`);
    expect(text).toContain('chỉ chạm manifest/lockfile (+ paths)');
    expect(text).toContain('Quét');
  });

  it('scans the base once, when the Goal is opened, and reuses it at every submit', async () => {
    const log = `${temp('apos-scanlog-')}/log`;
    process.env.APOS_SCAN_LOG = log;
    const p = await prepare({}, ['--security', 'CVE-FMT-1']);
    const onBase = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(line => line.startsWith('1.0.0')).length;
    const before = onBase();
    const sha = p.commitFiles('bump', { 'deps.json': manifest({ fmt: '1.1.0' }) });
    expect((await submit(p, sha)).code).toBe(0);
    expect(onBase()).toBe(before);
    expect(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(line => line.startsWith('1.1.0')),
    ).toHaveLength(2);
  });

  it('is unverifiable when two runs of a test layer disagree', async () => {
    const p = await prepare();
    const sha = p.commitFiles('bump', { 'deps.json': manifest({ fmt: '1.1.0' }) });
    process.env.APOS_FLAKY = `${temp('apos-flaky-')}/counter`;
    const got = await submit(p, sha);
    expect(got.code).toBe(3);
    expect(got.text).toMatch(/disagree/);
  });

  it('is unverifiable when two scans of the delivery show different findings', async () => {
    const p = await prepare();
    const sha = p.commitFiles('bump', { 'deps.json': manifest({ fmt: '1.1.0' }) });
    process.env.APOS_SCAN_FLAKY = `${temp('apos-flaky-')}/counter`;
    const got = await submit(p, sha);
    expect(got.code).toBe(3);
    expect(got.text).toMatch(/two scans of .* show different findings/);
  });

  it('is unverifiable, not red, when a scan of a security Goal does not agree with itself', async () => {
    const p = await prepare({}, ['--security', 'CVE-FMT-1']);
    const sha = p.commitFiles('bump', { 'deps.json': manifest({ fmt: '1.1.0' }) });
    process.env.APOS_SCAN_FLAKY = `${temp('apos-flaky-')}/counter`;
    const got = await submit(p, sha);
    expect(got.code).toBe(3);
    expect(got.text).toMatch(/APOS-SECURITY unverifiable/);
    expect(p.state('GOAL-MAINT-001')!.packages?.['WP-MAIN']?.attempts).toBe(0);
  });

  it('is unverifiable when two scans agree on a finding but not on its severity', async () => {
    const p = await prepare();
    const sha = p.commitFiles('bump', { 'deps.json': manifest({ fmt: '1.1.0' }) });
    process.env.APOS_SCAN_SEVERITY = `${temp('apos-severity-')}/counter`;
    const got = await submit(p, sha);
    expect(got.code).toBe(3);
    expect(got.text).toMatch(/two scans of .* show different findings/);
  });

  it('a sensitive manifest still waits for a decision an agent may give', async () => {
    const p = await prepare({ needsHuman: ['deps.json'] });
    const sha = p.commitFiles('bump', { 'deps.json': manifest({ fmt: '1.1.0' }) });
    const waiting = await submit(p, sha);
    expect(waiting.code).toBe(3);
    await p.invoke(
      'exception',
      'approve',
      'GOAL-MAINT-001',
      '--kind',
      'needs-human',
      '--ref',
      'WP-MAIN',
      '--reason',
      'bump',
      '--by',
      'agent:lead',
    );
    const done = await submit(p, sha);
    expect(done.code).toBe(0);
    await p.invoke('goal', 'show', 'GOAL-MAINT-001');
    expect(p.out.join('\n')).toContain('needs-human WP-MAIN (agent:lead)');
  });
});
