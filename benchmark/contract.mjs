import { z } from 'zod';
import { realpathSync } from 'node:fs';
import { dirname, basename, join, sep } from 'node:path';

const nonempty = z.string().min(1);
const relativePath = nonempty.refine(value => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'));
const caseSchema = z
  .object({
    id: nonempty,
    goalKind: z.enum(['feature', 'bugfix', 'refactor', 'maintenance', 'removal']),
    family: nonempty,
    severity: nonempty,
    truth: z.enum(['fault', 'clean', 'limitation']),
    expected: z.enum(['green', 'red', 'unverifiable', 'needs-human']),
    repository: relativePath,
    deliveryCommit: z.string().regex(/^[a-f0-9]{40}$/),
    oracle: nonempty,
    clock: z.iso.datetime().optional(),
    actions: z.array(z.array(nonempty).min(1)),
    goalId: nonempty,
    packageId: nonempty,
  })
  .strict();
const manifestSchema = z
  .object({ version: z.literal(1), cases: z.array(caseSchema).min(1) })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.cases.map(item => item.id)).size !== value.cases.length) {
      context.addIssue({ code: 'custom', message: 'case IDs must be unique' });
    }
  });
export const parseManifest = value => manifestSchema.parse(value);
export function readManifest(input) {
  try {
    return parseManifest(JSON.parse(input));
  } catch {
    throw new Error('Invalid corpus manifest');
  }
}
export function toCsv(rows, fields) {
  const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return `${fields.join(',')}\n${rows.map(row => fields.map(field => cell(row[field])).join(',')).join('\n')}\n`;
}

export function assertPrivateOutput(root, output) {
  const target = join(realpathSync(dirname(output)), basename(output));
  const checkout = realpathSync(root);
  if (target === checkout || target.startsWith(checkout + sep))
    throw new Error('output must be outside the APOS checkout');
  return target;
}
