import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, toCsv, assertPrivateOutput } from './contract.mjs';

const sample = {
  version: 1,
  cases: [
    {
      id: 'c1',
      goalKind: 'feature',
      family: 'boundary',
      severity: 'high',
      truth: 'fault',
      expected: 'red',
      repository: 'repos/example.bundle',
      deliveryCommit: '0123456789012345678901234567890123456789',
      oracle: 'boundary violates the requirement',
      actions: [['init']],
      goalId: 'GOAL-001',
      packageId: 'WP-MAIN',
    },
  ],
};
it('accepts a fixed delivery and independently stated oracle', () => {
  assert.deepEqual(parseManifest(sample), sample);
});
it('rejects missing oracle and moving git references', () => {
  assert.throws(() =>
    parseManifest({ ...sample, cases: [{ ...sample.cases[0], oracle: '', deliveryCommit: 'main' }] }),
  );
});
it('escapes commas, quotes and newlines in CSV', () => {
  assert.equal(
    toCsv([{ caseId: 'a,b', caughtBy: 'a"b\nc' }], ['caseId', 'caughtBy']),
    'caseId,caughtBy\n"a,b","a""b\nc"\n',
  );
});

it('rejects an output directory reached through a symlink into the public checkout', async () => {
  const { mkdtempSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const temp = mkdtempSync(join(tmpdir(), 'bench-path-'));
  symlinkSync(process.cwd(), join(temp, 'public'), 'dir');
  assert.throws(() => assertPrivateOutput(process.cwd(), join(temp, 'public', 'output')));
});

it('permits a fixed clock but rejects an invalid time for deadline-sensitive cases', () => {
  const item = { ...sample.cases[0], clock: '2026-11-24T08:00:00Z' };
  assert.equal(parseManifest({ ...sample, cases: [item] }).cases[0].clock, item.clock);
  assert.throws(() => parseManifest({ ...sample, cases: [{ ...item, clock: 'tomorrow' }] }));
});
