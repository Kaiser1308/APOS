import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExceptionService } from './exceptions.js';
import { buildInbox } from './inbox.js';
import { cleanProjects, lockedProject } from './test-lock.test-support.js';

afterEach(cleanProjects);

async function needsHuman() {
  const p = await lockedProject();
  const commit = p.commit({ 'src/impl.txt': 'add\n', 'pyproject.toml': '[project]\n' }, 'deps');
  const first = await p.submit(commit);
  expect(first.result).toBe('needs-human');
  return { p, commit, service: new ExceptionService(p.journal) };
}

describe('exception approve', () => {
  it("an agent's approval makes the same commit green on resubmit without running the gate again, and is logged as agent:<name>", async () => {
    const { p, commit, service } = await needsHuman();
    service.approve(p.goalId, {
      kind: 'needs-human',
      ref: 'WP-MAIN',
      reason: 'lockfile bump reviewed',
      by: 'agent:lead',
    });
    expect(p.state().exceptions).toMatchObject([{ kind: 'needs-human', ref: 'WP-MAIN', commit, by: 'agent:lead' }]);
    const run = vi.spyOn(p.gate, 'runPackage');
    const again = await p.submit(commit);
    expect(run).not.toHaveBeenCalled();
    expect(again.result).toBe('green');
    expect(p.state().status).toBe('verified');
    const scope = p.state().packages?.['WP-MAIN']?.gate?.checks.find(check => check.checkId === 'APOS-SCOPE');
    expect(scope).toMatchObject({
      status: 'pass',
      reason: expect.stringContaining('duyệt bởi agent:lead: lockfile bump reviewed') as unknown,
    });
  }, 180_000);

  it('does not carry to another commit: the gate runs and asks again', async () => {
    const { p, service } = await needsHuman();
    service.approve(p.goalId, { kind: 'needs-human', ref: 'WP-MAIN', reason: 'ok', by: 'agent:lead' });
    const other = p.commit({ 'pyproject.toml': '[project]\nname = "x"\n' }, 'another change');
    const run = vi.spyOn(p.gate, 'runPackage');
    expect((await p.submit(other)).result).toBe('needs-human');
    expect(run).toHaveBeenCalledOnce();
  }, 240_000);

  it('records the Human with their confirmation', async () => {
    const { p, service } = await needsHuman();
    service.approve(p.goalId, {
      kind: 'needs-human',
      ref: 'WP-MAIN',
      reason: 'ok',
      by: 'human',
      confirmation: { by: 'on-behalf', onBehalf: 'item 3' },
    });
    expect(p.state().exceptions?.[0]).toMatchObject({ by: 'human', confirmation: { by: 'on-behalf' } });
  }, 120_000);

  it('refuses what is not waiting: a green package, an unknown kind, a bad approver, floor-reduced, an empty reason', async () => {
    const p = await lockedProject();
    const service = new ExceptionService(p.journal);
    const ask = (over: object) => () =>
      service.approve(p.goalId, { kind: 'needs-human', ref: 'WP-MAIN', reason: 'r', by: 'agent:lead', ...over });
    expect(ask({})).toThrow(/WP-MAIN is pending: only a package that needs a human/);
    expect(ask({ kind: 'nope' })).toThrow(/--kind is one of/);
    expect(ask({ by: 'lead' })).toThrow(/--by is agent:<name>/);
    expect(ask({ kind: 'floor-reduced' })).toThrow(/reserved for phase 4/);
    expect(ask({ reason: ' ' })).toThrow(/--reason is required/);
    expect(ask({ kind: 'tests-weakened', ref: 'a'.repeat(40) })).toThrow(
      /revision waiting for approval: there is none/,
    );
    expect(() => service.approve('GOAL-NOPE', { kind: 'needs-human', ref: 'x', reason: 'r', by: 'agent:x' })).toThrow(
      /Goal not found/,
    );
  }, 120_000);
});

it('refuses a needs-human package that waits for something else (a manual check, a flaky check): approving would change nothing', () => {
  const commit = 'a'.repeat(40);
  const state = {
    spec: { id: 'GOAL-1' },
    status: 'executing',
    packages: {
      'WP-A': {
        status: 'needs-human',
        submission: { commit },
        gate: { checks: [{ checkId: 'CHK-M', status: 'manual-pending' }] },
      },
    },
  };
  const store = { getGoal: () => state } as unknown as ConstructorParameters<typeof ExceptionService>[0];
  expect(() =>
    new ExceptionService(store).approve('GOAL-1', { kind: 'needs-human', ref: 'WP-A', reason: 'r', by: 'agent:x' }),
  ).toThrow(/waits for something an exception does not settle/);
});

describe('tests-infra', () => {
  it('an agent approves it; the report and inbox say which infra file and who approved; the same commit is green without a rerun', async () => {
    const p = await lockedProject({ paths: ['src/**', 'tests/**'] });
    const commit = p.commit({ 'src/impl.txt': 'add\n', 'tests/infra.cfg': 'plain, edited\n' }, 'infra');
    expect((await p.submit(commit)).result).toBe('needs-human');
    const service = new ExceptionService(p.journal);
    // A sensitive-file approval does not settle an infra change.
    expect(() =>
      service.approve(p.goalId, { kind: 'needs-human', ref: 'WP-MAIN', reason: 'r', by: 'agent:lead' }),
    ).toThrow(/waits for something an exception does not settle/);
    service.approve(p.goalId, { kind: 'tests-infra', ref: 'WP-MAIN', reason: 'config tidy', by: 'agent:lead' });
    const run = vi.spyOn(p.gate, 'runPackage');
    expect((await p.submit(commit)).result).toBe('green');
    expect(run).not.toHaveBeenCalled();
    const infra = p.state().packages?.['WP-MAIN']?.gate?.checks.find(check => check.checkId === 'APOS-INFRA');
    expect(infra?.reason).toBe('hạ tầng test bị sửa: tests/infra.cfg, duyệt bởi agent:lead: config tidy');
  }, 180_000);

  it('the inbox names the file and the command, then who approved', async () => {
    const p = await lockedProject({ paths: ['src/**', 'tests/**'] });
    const commit = p.commit({ 'src/impl.txt': 'add\n', 'tests/infra.cfg': 'x\n' }, 'infra');
    await p.submit(commit);
    const reasons = () =>
      buildInbox(p.journal).flatMap(item => (JSON.parse(item.detail) as { reasons?: string[] }).reasons ?? []);
    expect(reasons()[0]).toContain('hạ tầng test bị sửa: tests/infra.cfg. Approve with: apos exception approve');
    expect(reasons()[0]).toContain('--kind tests-infra --ref WP-MAIN');
    new ExceptionService(p.journal).approve(p.goalId, {
      kind: 'tests-infra',
      ref: 'WP-MAIN',
      reason: 'ok',
      by: 'agent:lead',
    });
    expect(reasons()[0]).toBe(
      'hạ tầng test bị sửa: tests/infra.cfg, duyệt bởi agent:lead: submit again with the same commit',
    );
  }, 180_000);
});
