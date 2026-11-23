import { z } from 'zod';

import { entryRuleSchema } from './entry-rule.js';
import { runOneProblem } from './run-one.js';
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
  /** Exit codes accepted when a report-producing tool has a meaningful report despite a nonzero exit. */
  reportExitCodes: z.array(z.number().int()).min(1).optional(),
  metric: z.string().trim().min(1).optional(),
  runOne: z
    .string()
    .trim()
    .min(1)
    .superRefine((value, ctx) => {
      const problem = runOneProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: `runOne ${problem}` });
    })
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
  /** Globs, relative to the part's root, of the files that hold tests: what a tester may commit and what gets locked. */
  testPaths: z.array(z.string().min(1)).default([]),
  /** Globs of files that change how tests run without being tests (conftest, runner config, setup files): changing one needs a decision. */
  testInfra: z.array(z.string().min(1)).default([]),
  /** Regexes that count an assertion in a test file, line by line. A rough count, not a parse. */
  assertPatterns: z.array(regex),
  /** Regexes that recognise "not implemented yet" in a failing test's message . */
  notImplementedPatterns: z.array(regex),
  /** Regexes that recognise a test that never loaded (collection, import or class-init error), matched on the failure message. */
  loadErrorPatterns: z.array(regex).default([]),
  /** How to tell which module a test imports, so a test can be held to the declared entries. Absent: the stack's tests are not checked that way and the assurance table says so. */
  entryRule: entryRuleSchema.optional(),
  /** Regexes forbidden in added diff lines: the strict floor a draft starts with. */
  forbid: z.array(regex),
  /** Globs of sensitive files that need a Human. */
  needsHuman: z.array(z.string().min(1)),
  /** Free text for humans: which tool versions the commands were checked against, and what was not. */
  notes: z.array(z.string()).optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
