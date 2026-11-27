import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readGateResult } from './result.mjs';

it('reads the APOS JSON verdict and preserves evidence, including needs-human', () => {
  const stdout = JSON.stringify({
    command: 'package submit',
    verdict: 'needs-human',
    evidence: [{ digest: 'abc' }],
    caughtBy: null,
    setupVersion: 2,
  });
  assert.deepEqual(readGateResult(stdout, 3), {
    actualVerdict: 'needs-human',
    evidenceDigest: ['abc'],
    caughtBy: null,
    setupVersion: 2,
  });
});
it('rejects missing verdict and mismatched exit instead of turning execution failures into a gate result', () => {
  assert.throws(() => readGateResult('{"error":"failed"}', 1));
  assert.throws(() => readGateResult('{"command":"package submit","verdict":"green","evidence":[]}', 1));
});
it('rejects a verdict for another commit or Goal', () => {
  const response = JSON.stringify({
    command: 'package submit',
    goalId: 'G',
    packageId: 'W',
    commit: 'a'.repeat(40),
    verdict: 'green',
    evidence: [],
  });
  assert.throws(() => readGateResult(response, 0, { goalId: 'G', packageId: 'W', commit: 'b'.repeat(40) }));
});

it('records the failing check IDs reported by APOS without counting abstentions as catches', () => {
  const stdout = JSON.stringify({
    command: 'package submit',
    verdict: 'red',
    evidence: [],
    caughtBy: null,
    reasons: ['APOS-LOCKED fail: assertion failed', 'app.L2 unverifiable: missing report'],
  });
  assert.deepEqual(readGateResult(stdout, 1).caughtBy, ['APOS-LOCKED']);
});

it('does not leak malformed APOS output in an error message', () => {
  assert.throws(
    () => readGateResult('private-case-content is invalid JSON', 1),
    error => {
      assert.equal(error.message, 'APOS returned an invalid package result');
      return true;
    },
  );
});
