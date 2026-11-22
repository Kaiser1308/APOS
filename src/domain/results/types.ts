export type ResultFormat = 'junit' | 'sarif' | 'metric' | 'apos-json';
export type TestOutcome = { id: string; status: 'pass' | 'fail' | 'error' | 'skip'; message?: string };
export type Finding = { ruleId: string; level: 'error' | 'warning' | 'note'; file?: string; line?: number };
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
