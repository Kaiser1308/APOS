import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './cli.js';

const self = fileURLToPath(new URL('./cli.ts', import.meta.url));

it('recognizes the entry point when it is started through a symlink (npm link, npm install -g)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-bin-'));
  try {
    const link = join(dir, 'apos');
    try {
      symlinkSync(self, link);
    } catch {
      return; // no permission to create symlinks (Windows without developer mode)
    }
    expect(isEntryPoint(link, self)).toBe(true);
    expect(isEntryPoint(self, self)).toBe(true);
    expect(isEntryPoint(join(dir, 'other'), self)).toBe(false);
    expect(isEntryPoint(undefined, self)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
