import { it } from 'node:test';
import assert from 'node:assert/strict';
import { gateCommandCount } from './cost.mjs';

it('counts gate-bearing preparation commands and the measured package submission', () => {
  assert.equal(gateCommandCount([['init'], ['package', 'submit', 'G', 'W'], ['outcome', 'close', 'G']]), 3);
});

it('exports duration and total CPU in documented units', async () => {
  const { costFields } = await import('./cost.mjs');
  assert.deepEqual(costFields({ durationMs: 2500, userCpuSeconds: 1.5, systemCpuSeconds: 0.25 }), {
    duration: 2500,
    cpu: 1.75,
  });
});
