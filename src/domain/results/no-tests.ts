import type { ParsedReport } from './types.js';

/** How a stack's test tool says "there is no test here", declared in the catalog and pinned in the setup. */
export type NoTestsSignals = {
  exitCodes: number[];
  patterns: string[];
  /** Words of a tool that is broken, not empty (the stack's `loadErrorPatterns`): the output matching one is never "no tests". */
  broken?: string[];
};

/**
 * Whether a test tool that ran found no test at all, as opposed to one that is broken. The tool must have said so (its
 * exit code is one the stack declares, or its output matches a declared pattern) and its report must agree: a readable
 * report of zero tests. A report that holds tests overrules the signal. With no usable report, only the tool's own words
 * count: an exit code alone could be a crash. A tool can say "no test files" and still be broken (vitest prints it when a
 * `globalSetup` throws), so output that also carries a sign of a broken tool is not "no tests" either. Returns the reason,
 * or undefined when this is not "no tests".
 */
export function noTestsReason(input: {
  exitCode: number | null;
  output: string;
  report?: ParsedReport;
  signals: NoTestsSignals;
}): string | undefined {
  const { exitCode, output, report, signals } = input;
  if (signals.broken?.some(item => new RegExp(item, 'm').test(output))) return undefined;
  const byCode = exitCode !== null && signals.exitCodes.includes(exitCode);
  const pattern = signals.patterns.find(item => new RegExp(item, 'm').test(output));
  if (!byCode && pattern === undefined) return undefined;
  if (report?.kind === 'tests')
    return report.tests.length
      ? undefined
      : byCode
        ? `the tool reports no tests (exit ${exitCode}, empty report)`
        : `the tool reports no tests (/${pattern}/)`;
  return pattern === undefined ? undefined : `the tool reports no tests (/${pattern}/)`;
}
