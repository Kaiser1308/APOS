import { z } from 'zod';

import type { ResultFormat } from './results/types.js';

export const RESULT_FORMATS = ['junit', 'sarif', 'metric', 'apos-json'] as const satisfies readonly ResultFormat[];
/** `exit` is for tools with no report (tsc, compile, checkstyle): pass or fail by exit code only, no test ids. */
export const TOOL_FORMATS = [...RESULT_FORMATS, 'exit'] as const;

/**
 * One command that produces a standard report. `{report}` in `command` is replaced by a path APOS provides.
 * `runOne` runs a single test (needed to prove a test can be run alone): `{id}` is the whole test id
 * (`<classname>::<name>`), `{classname}` and `{name}` its two halves, split at the first `::`.
 */
export const catalogToolSchema = z.object({
  id: z.string().trim().min(1),
  command: z.string().trim().min(1),
  format: z.enum(TOOL_FORMATS),
  report: z.string().trim().min(1).optional(),
  metric: z.string().trim().min(1).optional(),
  runOne: z
    .string()
    .trim()
    .min(1)
    .refine(value => /\{(id|classname|name)\}/.test(value), 'runOne must contain {id}, {classname} or {name}')
    .optional(),
});
export type CatalogTool = z.infer<typeof catalogToolSchema>;

const regex = z.string().refine(value => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, 'not a valid regular expression');
const catalogLayerId = z.enum(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);

/**
 * What APOS knows about one stack. It is a starting point for a Lead drafting a setup and carries no
 * guarantee: only an approved setup decides what the gate runs.
 */
export const catalogEntrySchema = z.object({
  stack: z.string().regex(/^[a-z][a-z0-9-]*$/, 'stack is a lowercase word'),
  /** A stack is recognised in a directory when every file exists and every `contains` substring is found. */
  detect: z.object({
    files: z.array(z.string().min(1)).min(1),
    contains: z.record(z.string(), z.string().min(1)).optional(),
  }),
  layers: z.partialRecord(catalogLayerId, z.array(catalogToolSchema).min(1)),
  /** Regexes that count an assertion in a test file (wave 3). */
  assertPatterns: z.array(regex),
  /** Regexes that recognise "not implemented yet" in a failing test's message (wave 3). */
  notImplementedPatterns: z.array(regex),
  /** Regexes forbidden in added diff lines: the strict floor a draft starts with. */
  forbid: z.array(regex),
  /** Globs of sensitive files that need a Human. */
  needsHuman: z.array(z.string().min(1)),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
