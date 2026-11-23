import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { withGateLease } from './lease.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('lets only one gate run per home and clears a lease left by a dead process', async () => {
  const home = mkdtempSync(join(tmpdir(), 'apos-lease-'));
  dirs.push(home);
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  try {
    writeFileSync(join(home, 'gate.lease'), JSON.stringify({ pid: other.pid, at: new Date().toISOString() }));
    expect(await withGateLease(home, async () => 'gate')).toEqual({ ran: false, holder: other.pid });
  } finally {
    other.kill();
  }
  writeFileSync(join(home, 'gate.lease'), JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  expect(await withGateLease(home, async () => 'gate')).toEqual({ ran: true, value: 'gate' });
  expect(existsSync(join(home, 'gate.lease'))).toBe(false);
});
