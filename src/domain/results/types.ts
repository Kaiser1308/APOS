export type ResultFormat = 'junit' | 'sarif' | 'metric' | 'apos-json';
export type TestOutcome = {
  id: string;
  status: 'pass' | 'fail' | 'error' | 'skip';
  message?: string;
  /** The `file` attribute of the testcase when the runner writes one (pytest with junit_family=xunit1). */
  file?: string;
};
export type Finding = {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  file?: string;
  line?: number;
  /** Stable across runs and across edits that only move lines: the SARIF `partialFingerprints`, else a hash of rule, path and message. */
  fingerprint: string;
};
export type ParsedReport =
  | { kind: 'tests'; tests: TestOutcome[] }
  | { kind: 'findings'; findings: Finding[] }
  | { kind: 'metric'; name: string; value: number }
  | { kind: 'unreadable'; reason: string };

export const unreadable = (reason: string): ParsedReport => ({ kind: 'unreadable', reason });

/** Parses JSON text, or undefined when it is not JSON. */
export function parseJson(content: string): unknown {
  try {
    return JSON.parse(content.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}
