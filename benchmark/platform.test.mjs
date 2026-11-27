import { it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSupportedPlatform } from './platform.mjs';

it('rejects unsupported platforms before any benchmark output is created', () => {
  assert.throws(() => assertSupportedPlatform('win32'), /requires Linux/);
  assert.throws(() => assertSupportedPlatform('darwin'), /requires Linux/);
  assert.doesNotThrow(() => assertSupportedPlatform('linux'));
});

it('refuses the benchmark entry point before creating output on Windows', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'bench-unsupported-'));
  const output = join(root, 'output');
  const script = `Object.defineProperty(process, 'platform', { value: 'win32' }); process.argv = ['node', 'bench', ${JSON.stringify(root)}, ${JSON.stringify(output)}]; await import(${JSON.stringify(new URL('./bench.mjs', import.meta.url).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve('.'),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /benchmark requires Linux/);
  assert.equal(existsSync(output), false);
});
