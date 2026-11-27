import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveCheckpoint } from './checkpoint.mjs';

it('preserves each completed row privately even if a later case fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-checkpoint-'));
  saveCheckpoint(dir, { actualVerdict: 'unverifiable' });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), { actualVerdict: 'unverifiable' });
  assert.equal(statSync(join(dir, 'result.json')).mode & 0o777, 0o600);
});

it('records the sealed corpus identity before starting any gate', async () => {
  const { saveRunIdentity } = await import('./checkpoint.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-seal-'));
  saveRunIdentity(dir, { corpusDigest: 'abc', aposCommit: 'def' });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')), { corpusDigest: 'abc', aposCommit: 'def' });
});
