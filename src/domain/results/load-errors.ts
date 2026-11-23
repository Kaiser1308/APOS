import type { TestOutcome } from './types.js';

const firstLine = (text: string) => (text.split(/\r?\n/).find(line => line.trim()) ?? '').trim().slice(0, 200);

/**
 * Whether a report shows tests that never loaded (a collection or import error, a broken class) rather than
 * tests that ran. Every test erroring means nothing ran; otherwise a failing test whose message matches one of
 * the stack's `loadErrorPatterns` is a load error. Returns the reason, or undefined when the tests did load.
 */
export function loadFailure(tests: TestOutcome[], patterns: string[] = []): string | undefined {
  if (!tests.length) return undefined;
  const label = (test: TestOutcome) => firstLine(test.message ?? '') || test.id;
  if (tests.every(test => test.status === 'error')) return `tests could not load: ${label(tests[0]!)}`;
  const compiled = patterns.map(pattern => new RegExp(pattern, 'm'));
  const broken = tests.find(
    test => (test.status === 'error' || test.status === 'fail') && compiled.some(re => re.test(test.message ?? '')),
  );
  return broken ? `tests could not load: ${label(broken)}` : undefined;
}
