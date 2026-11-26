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

it('does not mistake a successful test log for a missing executable', () => {
  const output = 'test logged: exec: "missing": executable file not found in $PATH';
  expect(notRunnable({ exitCode: 0, timedOut: false, output })).toBeUndefined();
  expect(
    notRunnable({
      exitCode: 0,
      timedOut: false,
      output: 'apos go-junit: exec: "gotestsum": executable file not found in $PATH',
    }),
  ).toBeUndefined();
});

it('still detects missing executables from failed processes and masked shell errors', () => {
  expect(notRunnable({ exitCode: 1, timedOut: false, output: 'executable file not found in $PATH' })).toBe(
    'command not found',
  );
  expect(notRunnable({ exitCode: 0, timedOut: false, output: 'ghost: command not found' })).toBe('command not found');
});

it('recognizes a missing adapter executable on Windows', () => {
  expect(
    notRunnable({
      exitCode: 1,
      timedOut: false,
      output: 'apos go-junit: exec: "gotestsum": executable file not found in %PATH%\nexit status 1',
    }),
  ).toBe('command not found');
});
