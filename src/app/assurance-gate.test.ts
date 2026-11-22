import { afterEach, describe, expect, it } from 'vitest';
import { cleanProjects, lockedProject } from './test-lock.test-support.js';

afterEach(cleanProjects);

const reasons = (result: { reasons: string[] }) => result.reasons.join('\n');

describe('package gate with locked tests', () => {
  it('is green when the worker implements the stub and touches nothing else; the Goal is verified', async () => {
    const p = await lockedProject();
    const commit = p.commit({ 'src/impl.txt': 'add\n', 'src/stub.txt': 'done\n' }, 'implement');
    const result = await p.submit(commit);
    expect(result.reasons).toEqual([]);
    expect(result.result).toBe('green');
    expect(p.state().status).toBe('verified');
    const checks = p.state().packages?.['WP-MAIN']?.gate?.checks.map(item => `${item.checkId}:${item.status}`);
    expect(checks).toEqual(['CHK-1:pass', 'APOS-LOCKED:pass', 'APOS-INVENTORY:pass', 'APOS-SCOPE:pass']);
  }, 120_000);

  it('is red when the worker changes a locked test, even only its whitespace, and the reason names the file (review focus 5)', async () => {
    const p = await lockedProject();
    const commit = p.commit(
      { 'src/impl.txt': 'add\n', 'tests/acceptance/calc.t': 'case add needs add \n' },
      'edit the test',
    );
    const result = await p.submit(commit);
    expect(result.result).toBe('red');
    expect(reasons(result)).toContain('APOS-LOCKED fail: locked test modified: tests/acceptance/calc.t');
    expect(p.state().status).toBe('executing');
  }, 120_000);

  it('is red when a locked test still fails on the delivery', async () => {
    const p = await lockedProject();
    const result = await p.submit(p.commit({ 'src/stub.txt': 'nothing implemented\n' }, 'no work'));
    expect(result.result).toBe('red');
    expect(reasons(result)).toMatch(/APOS-LOCKED fail: AC-1 app\.L2 tests\.acceptance\.calc::add: is fail, not pass/);
  }, 120_000);

  it('is red when a test that existed at the base is deleted or turned into a skip', async () => {
    const p = await lockedProject();
    const deleted = await p.submit(p.commit({ 'src/impl.txt': 'add\n', 'tests/unit/u.t': null }, 'drop the unit test'));
    expect(deleted.result).toBe('red');
    expect(reasons(deleted)).toContain('APOS-INVENTORY fail: test missing: app.L1::tests.unit.u::one');
    const skipped = await p.submit(p.commit({ 'tests/unit/u.t': 'case one skip\n' }, 'skip the unit test'));
    expect(reasons(skipped)).toContain('test now skipped: app.L1::tests.unit.u::one');
  }, 180_000);

  it('is red for a forbidden pattern in a line the delivery adds', async () => {
    const p = await lockedProject();
    const result = await p.submit(p.commit({ 'src/impl.txt': 'add\n', 'src/notes.txt': '# @skip this\n' }, 'notes'));
    expect(result.result).toBe('red');
    expect(reasons(result)).toContain('forbidden pattern /@skip/');
  }, 120_000);

  it('is red for a file outside the package paths', async () => {
    const p = await lockedProject();
    const result = await p.submit(p.commit({ 'src/impl.txt': 'add\n', 'docs/readme.md': 'x\n' }, 'docs'));
    expect(result.result).toBe('red');
    expect(reasons(result)).toContain(
      'APOS-SCOPE fail: outside the package paths (src/**, tests/unit/**, src/stub.txt): docs/readme.md',
    );
  }, 120_000);

  it('needs a human for a sensitive file, and that file is not also called out of scope', async () => {
    const p = await lockedProject();
    const result = await p.submit(p.commit({ 'src/impl.txt': 'add\n', 'pyproject.toml': '[project]\n' }, 'deps'));
    expect(result.result).toBe('needs-human');
    expect(reasons(result)).toContain(
      'APOS-SCOPE needs-human: sensitive files changed, a decision is needed: pyproject.toml',
    );
    expect(p.state().packages?.['WP-MAIN']?.status).toBe('needs-human');
  }, 120_000);

  it('does not warn about changed tests once they are locked: the gate is red instead', async () => {
    const p = await lockedProject();
    const result = await p.submit(
      p.commit({ 'src/impl.txt': 'add\n', 'tests/unit/new.t': 'case two pass\n' }, 'more tests'),
    );
    expect(result.warnings.join('\n')).not.toMatch(/tests or oracles changed/);
  }, 120_000);

  it('refuses a package branched from the old base, telling the worker to rebase onto the lock commit (review focus 3)', async () => {
    const p = await lockedProject();
    p.git('checkout', '-q', '-b', 'old', p.base);
    const commit = p.commit({ 'src/impl.txt': 'add\n' }, 'work on the old base');
    await expect(p.submit(commit)).rejects.toThrow(
      new RegExp(`does not contain the commit that locked the tests \\(${p.lockCommit}\\): rebase WP-MAIN onto it`),
    );
  }, 120_000);

  it('gates against the lock commit, not the plan base', async () => {
    const p = await lockedProject();
    const result = await p.submit(p.commit({ 'src/impl.txt': 'add\n' }, 'work'));
    expect(p.state().packages?.['WP-MAIN']?.gate?.baseCommit).toBe(p.lockCommit);
    expect(result.result).toBe('green');
  }, 120_000);
});

describe('the Goal-level gate (Multi-WP integration reads the diff from the plan base)', () => {
  it('does not warn about changed tests on a locked Goal either', async () => {
    const p = await lockedProject();
    const commit = p.commit({ 'src/impl.txt': 'add\n', 'tests/unit/new.t': 'case two pass\n' }, 'more tests');
    expect(p.gate.run(p.goalId, p.dir, { deliveryCommit: commit }).warnings?.join('\n') ?? '').not.toMatch(
      /tests or oracles/,
    );
  }, 120_000);

  it('a locked test edited while the runner is also broken is red, not unverifiable', async () => {
    const p = await lockedProject();
    const commit = p.commit(
      {
        'src/impl.txt': 'add\n',
        'runner.js': 'process.exit(2);\n',
        'tests/acceptance/calc.t': 'case add needs add \n',
      },
      'edit and break',
    );
    const result = await p.submit(commit);
    expect(result.result).toBe('red');
    expect(result.reasons.join('\n')).toContain('APOS-LOCKED fail: locked test modified: tests/acceptance/calc.t');
  }, 120_000);

  it('trusts tests.json while it is the blob that was locked, and no longer once it changes', async () => {
    const p = await lockedProject();
    const ok = p.commit({ 'src/impl.txt': 'add\n' }, 'work');
    const report = p.gate.run(p.goalId, p.dir, { deliveryCommit: ok });
    expect(report.changedFiles).toContain(`.apos/goals/${p.goalId}/tests.json`);
    expect(report.checks.map(check => check.checkId)).not.toContain('APOS-PROTECTED');
    const tampered = p.commit({ [`.apos/goals/${p.goalId}/tests.json`]: '[]' }, 'empty the map');
    expect(p.gate.run(p.goalId, p.dir, { deliveryCommit: tampered }).checks.map(check => check.checkId)).toContain(
      'APOS-PROTECTED',
    );
  }, 120_000);
});
