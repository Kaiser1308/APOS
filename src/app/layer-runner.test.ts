import { expect, it } from 'vitest';
import { notRunnable } from './layer-runner.js';

it('names a missing tool started by an adapter even when the wrapper exits 1', () => {
  expect(
    notRunnable({
      exitCode: 1,
      timedOut: false,
      output: 'apos go-junit: exec: "gotestsum": executable file not found in $PATH\nexit status 1',
    }),
  ).toBe('command not found');
});
