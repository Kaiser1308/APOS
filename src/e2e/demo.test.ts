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
