import { z } from 'zod';

export const RESULT_FORMATS = ['junit', 'sarif', 'metric', 'apos-json'] as const;

/**
 * One command that produces a standard report. `{report}` in `command` is replaced by a path APOS provides;
 * `runOne` runs a single test by `{id}` (needed to prove a test can be run alone).
 */
export const catalogToolSchema = z.object({
  id: z.string().trim().min(1),
  command: z.string().trim().min(1),
  format: z.enum(RESULT_FORMATS),
  report: z.string().trim().min(1).optional(),
  metric: z.string().trim().min(1).optional(),
  runOne: z
    .string()
    .trim()
    .min(1)
    .refine(value => value.includes('{id}'), 'runOne must contain {id}')
    .optional(),
});
export type CatalogTool = z.infer<typeof catalogToolSchema>;
