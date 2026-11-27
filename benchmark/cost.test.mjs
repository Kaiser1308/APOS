import { it } from 'node:test';
import assert from 'node:assert/strict';
import { gateCommandCount } from './cost.mjs';

it('counts gate-bearing preparation commands and the measured package submission', () => {
  assert.equal(gateCommandCount([['init'], ['package', 'submit', 'G', 'W'], ['outcome', 'close', 'G']]), 3);
});
