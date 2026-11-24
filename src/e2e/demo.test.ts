import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasPytest, hasVitest } from './layers-scenario.test-support.js';

/**
 * `scripts/demo-goal.mjs` runs an example Goal through the whole flow with the built binary and a real runner, and checks
 * the exit code of each step itself: if it exits 0, every step ended as the story says. The build goes to `dist/`, like
 * `npm run build`. Without a tool the example needs, the script exits 2 and says what is missing, and these tests skip.
 */
const script = resolve('scripts', 'demo-goal.mjs');
const hasPython = ['python', 'python3'].some(tool => spawnSync(tool, ['--version']).status === 0);

beforeAll(() => {
  const built = spawnSync(process.execPath, [resolve('node_modules', 'typescript', 'bin', 'tsc'), '-p', '.'], {
    encoding: 'utf8',
  });
  if (built.status !== 0) throw new Error(`tsc failed: ${built.stdout}${built.stderr}`);
  expect(existsSync(resolve('dist', 'cli.js'))).toBe(true);
}, 180_000);

describe('demo-goal.mjs', () => {
  it('refuses with exit 2, and says why, for an example it does not know or a binary that is not built', () => {
    const unknown = spawnSync(process.execPath, [script, 'nope'], { encoding: 'utf8' });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('usage');
    const unbuilt = spawnSync(process.execPath, [script, 'ts-orders', '--bin', 'no/such/cli.js'], { encoding: 'utf8' });
    expect(unbuilt.status).toBe(2);
    expect(unbuilt.stderr).toContain('npm run build');
  });

  it.skipIf(!hasVitest)(
    'ts-orders: tests locked, locked-test edit red, bug red, green, review block red, final fix green, closed',
    () => {
      const done = spawnSync(process.execPath, [script, 'ts-orders'], { encoding: 'utf8' });
      expect(done.stderr).toBe('');
      expect(done.stdout).toContain('every step ended as expected');
      expect(done.stdout).toContain('blocked by review');
      expect(done.status).toBe(0);
    },
    600_000,
  );

  it.skipIf(!hasVitest)(
    'ts-bug: a bug opened, approved in one command, a test that does not reproduce it refused, reproduced, fixed, closed',
    () => {
      const done = spawnSync(process.execPath, [script, 'ts-bug'], { encoding: 'utf8' });
      expect(done.stderr).toBe('');
      expect(done.stdout).toContain('every step ended as expected');
      expect(done.stdout).toContain('test không tái hiện lỗi');
      expect(done.stdout).toContain('lỗi được tái hiện bằng test');
      expect(done.status).toBe(0);
    },
    600_000,
  );

  it.skipIf(!hasVitest)(
    'ts-hotfix: a hotfix let through by the Human, overdue in the inbox, then proved by a test red before it and green with it',
    () => {
      const done = spawnSync(process.execPath, [script, 'ts-hotfix'], { encoding: 'utf8' });
      expect(done.stderr).toBe('');
      expect(done.stdout).toContain('every step ended as expected');
      expect(done.stdout).toContain('Human decision');
      expect(done.stdout).toContain('quá hạn 2026-11-25T08:00:00.000Z, chưa có bằng chứng');
      expect(done.stdout).toContain('APOS-HOTFIX fail');
      expect(done.stdout).toContain('chấp nhận khẩn cấp bởi');
      expect(done.status).toBe(0);
    },
    600_000,
  );

  it.skipIf(!hasVitest)(
    'ts-maint: a dependency upgrade held to the base: a new failure is red, a file outside the manifests is red, the upgrade that removes the finding is green',
    () => {
      const done = spawnSync(process.execPath, [script, 'ts-maint'], { encoding: 'utf8' });
      expect(done.stderr).toBe('');
      expect(done.stdout).toContain('every step ended as expected');
      expect(done.stdout).toContain('new failure(s) vs the base');
      expect(done.stdout).toContain('outside the package paths');
      expect(done.stdout).toContain('có trên');
      expect(done.stdout).toContain('không còn trên');
      expect(done.status).toBe(0);
    },
    600_000,
  );

  it.skipIf(!(hasPytest && hasPython))(
    'py-legacy: a repo with no tests approved as low assurance, behaviour captured, a refactor held to it',
    () => {
      const done = spawnSync(process.execPath, [script, 'py-legacy'], { encoding: 'utf8' });
      expect(done.stderr).toBe('');
      expect(done.stdout).toContain('every step ended as expected');
      expect(done.stdout).toContain('--baseline-missing');
      expect(done.stdout).toContain('chụp hành vi phải xanh trên code như hiện tại');
      expect(done.stdout).toContain('APOS-CHARACTERIZED fail');
      expect(done.stdout).toContain('giữ nguyên hành vi: 4 test chụp từ GOAL-001');
      expect(done.status).toBe(0);
    },
    600_000,
  );

  it.skipIf(!(hasPytest && hasPython))(
    'py-remove: a feature removed with the old tests the Goal declared: one more is red, one forgotten is red, exactly those gone is green',
    () => {
      const done = spawnSync(process.execPath, [script, 'py-remove'], { encoding: 'utf8' });
      expect(done.stderr).toBe('');
      expect(done.stdout).toContain('every step ended as expected');
      expect(done.stdout).toContain('will remove these tests, and only these');
      expect(done.stdout).toContain('test missing: app.L1::tests.test_cart::test_an_empty_cart_totals_zero');
      expect(done.stdout).toContain('declared removed but still there');
      expect(done.stdout).toContain('xoá đúng 2 test đã khai');
      expect(done.status).toBe(0);
    },
    600_000,
  );

  it.skipIf(!(hasPytest && hasPython))(
    'py-parking: the same story with pytest',
    () => {
      const done = spawnSync(process.execPath, [script, 'py-parking'], { encoding: 'utf8' });
      expect(done.stderr).toBe('');
      expect(done.stdout).toContain('every step ended as expected');
      expect(done.status).toBe(0);
    },
    600_000,
  );
});
