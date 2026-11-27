import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './metrics.mjs';

describe('benchmark metrics', () => {
  it('keeps abstentions separate and uses all eligible cases as denominators', () => {
    const rows = [
      { truth: 'fault', family: 'boundary', actualVerdict: 'green' },
      { truth: 'fault', family: 'boundary', actualVerdict: 'red' },
      { truth: 'fault', family: 'boundary', actualVerdict: 'unverifiable' },
      { truth: 'clean', family: 'scope', actualVerdict: 'red' },
      { truth: 'clean', family: 'scope', actualVerdict: 'needs-human' },
      { truth: 'limitation', family: 'boundary', actualVerdict: 'green' },
    ];
    const result = summarize(rows);
    assert.deepEqual(result.falseGreen, { count: 1, denominator: 3, rate: 1 / 3 });
    assert.deepEqual(result.falseRed, { count: 1, denominator: 2, rate: 1 / 2 });
    assert.deepEqual(result.unverifiable, { count: 1, denominator: 6, rate: 1 / 6 });
    assert.deepEqual(result.needsHuman, { count: 1, denominator: 6, rate: 1 / 6 });
    assert.deepEqual(result.byFamily.boundary, { count: 1, denominator: 3, rate: 1 / 3 });
    assert.equal(result.knownLimitations, 1);
  });
  it('reports null rather than inventing a rate when a population is empty', () => {
    assert.deepEqual(summarize([]).falseGreen, { count: 0, denominator: 0, rate: null });
  });
});

it('exposes aggregate metrics and family detections as CSV rows', async () => {
  const { metricRows } = await import('./metrics.mjs');
  const summary = summarize([{ truth: 'fault', family: 'boundary', actualVerdict: 'red' }]);
  assert.deepEqual(
    metricRows(summary).find(row => row.metric === 'detection' && row.family === 'boundary'),
    {
      metric: 'detection',
      family: 'boundary',
      count: 1,
      denominator: 1,
      rate: 1,
    },
  );
});
