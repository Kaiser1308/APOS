import { describe, expect, it } from 'vitest';
import { noTestsReason } from './no-tests.js';

const signals = { exitCodes: [5], patterns: ['No test files found'] };
const empty = { kind: 'tests', tests: [] } as const;
const ran = { kind: 'tests', tests: [{ id: 'a::b', status: 'pass' }] } as const;

describe('noTestsReason', () => {
  it('is no tests when the declared exit code comes with an empty report', () => {
    expect(noTestsReason({ exitCode: 5, output: '', report: empty, signals })).toMatch(/exit 5/);
  });
  it('is no tests when the tool says so and writes no report', () => {
    expect(noTestsReason({ exitCode: 1, output: 'No test files found, exiting', signals })).toMatch(/No test files/);
  });
  it('is not no tests when another exit code comes with an empty report, or the tool crashed without a report', () => {
    expect(noTestsReason({ exitCode: 4, output: '', report: empty, signals })).toBeUndefined();
    expect(noTestsReason({ exitCode: 5, output: '', signals })).toBeUndefined();
    expect(noTestsReason({ exitCode: 1, output: 'Error: cannot load config', signals })).toBeUndefined();
  });
  it('lets a report that holds tests overrule the signal', () => {
    expect(noTestsReason({ exitCode: 5, output: 'No test files found', report: ran, signals })).toBeUndefined();
  });
  it('is not no tests when the same output shows the tool is broken (vitest says "no test files" when a globalSetup throws)', () => {
    const output = 'No test files found, exiting with code 1\nUnhandled Error\nError: boom in global setup';
    expect(noTestsReason({ exitCode: 1, output, report: empty, signals })).toMatch(/No test files/);
    expect(
      noTestsReason({ exitCode: 1, output, report: empty, signals: { ...signals, broken: ['Unhandled Error'] } }),
    ).toBeUndefined();
  });
  it('says nothing for a stack that declares no signal', () => {
    expect(
      noTestsReason({
        exitCode: 5,
        output: 'No test files found',
        report: empty,
        signals: { exitCodes: [], patterns: [] },
      }),
    ).toBeUndefined();
  });
});
