import { createHash } from 'node:crypto';
import { z } from 'zod';
import { catalogToolSchema } from './catalog.js';
import { UserError } from './errors.js';
import type { SetupCodec } from './setup-codec.js';
import { LAYER_IDS, type LayerId } from './layers.js';

export type { LayerId } from './layers.js';
const STAGES = ['submit', 'integrate', 'close'] as const;

const layerId = z.enum(LAYER_IDS);
const layerSpec = catalogToolSchema.extend({
  /** `always` (default) or `flag:<name>`: the layer runs only when the Goal carries that flag. */
  when: z
    .string()
    .regex(/^(always|flag:[A-Za-z][A-Za-z0-9_-]*)$/, 'when must be "always" or "flag:<name>"')
    .optional(),
});
export type LayerSpec = z.infer<typeof layerSpec>;

const layers = z.partialRecord(layerId, z.array(layerSpec)).superRefine((value, ctx) => {
  for (const [layer, tools] of Object.entries(value)) {
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.id)) ctx.addIssue({ code: 'custom', message: `duplicate tool id "${tool.id}" in ${layer}` });
      seen.add(tool.id);
    }
  }
});

/** A repo-relative directory: forward slashes, no `.`/`..` segments, no trailing slash; `.` is the repo root. */
const root = z
  .string()
  .trim()
  .transform(value => value.replaceAll('\\', '/'))
  .refine(
    value => !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.split('/').includes('..'),
    'root must be a directory inside the repo',
  )
  .transform(
    value =>
      value
        .split('/')
        .filter(part => part && part !== '.')
        .join('/') || '.',
  );

const partSchema = z.object({
  root,
  stack: z.string().trim().min(1).optional(),
  layers,
  needsHuman: z.array(z.string().min(1)).default([]),
  forbid: z.array(z.string().min(1)).default([]),
  note: z.string().optional(),
});
export type PartSetup = z.infer<typeof partSchema>;

const triggerSchema = z.object({
  when: z
    .object({ changed: z.array(z.string().min(1)).min(1).optional(), goalFlag: z.string().min(1).optional() })
    .refine(value => value.changed !== undefined || value.goalFlag !== undefined, 'when needs changed or goalFlag'),
  at: z.enum(STAGES),
  /** Each entry is `<part>.<layer>` or `system.<layer>`. */
  run: z
    .array(z.string().regex(/^[a-z][a-z0-9-]*\.L[0-6]$/, 'run entries look like "<part>.L2" or "system.L4"'))
    .min(1),
});

const setupV2 = z
  .object({
    schemaVersion: z.literal(2),
    parts: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/, 'part names are lowercase words'), partSchema),
    system: layers.optional(),
    floor: z.partialRecord(z.enum(STAGES), z.array(layerId)).optional(),
    triggers: z.array(triggerSchema).optional(),
    mutation: z.object({ minScore: z.number().min(0).max(100) }).optional(),
  })
  .superRefine((setup, ctx) => {
    if (Object.hasOwn(setup.parts, 'system'))
      ctx.addIssue({ code: 'custom', message: '"system" is reserved for the layers that span parts, not a part name' });
    const byRoot = new Map<string, string>();
    for (const [name, part] of Object.entries(setup.parts)) {
      const other = byRoot.get(part.root);
      if (other)
        ctx.addIssue({ code: 'custom', message: `parts "${other}" and "${name}" have the same root "${part.root}"` });
      byRoot.set(part.root, name);
    }
    const defined = (target: string): boolean => {
      const [scope, layer] = target.split('.') as [string, LayerId];
      const where = scope === 'system' ? setup.system : setup.parts[scope]?.layers;
      return (where?.[layer]?.length ?? 0) > 0;
    };
    for (const trigger of setup.triggers ?? [])
      for (const target of trigger.run)
        if (!defined(target))
          ctx.addIssue({ code: 'custom', message: `trigger runs ${target}, which the setup does not define` });
  });
export type ProjectSetup = z.infer<typeof setupV2>;

export type ParsedSetup = { version: 1 } | { version: 2; setup: ProjectSetup };

const describe = (error: z.ZodError): string =>
  error.issues.map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ');

/**
 * Reads an already-parsed `.apos/project.yaml`. A repo from before setup v2 (schemaVersion 1, or an empty
 * file) has no setup: no guarantee depends on one. Anything else must be a valid v2 setup.
 */
export function parseSetupObject(value: unknown): ParsedSetup {
  if (value === null || value === undefined) return { version: 1 };
  const version = typeof value === 'object' ? (value as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version === 1) return { version: 1 };
  if (version !== 2) throw new UserError('.apos/project.yaml: schemaVersion must be 1 or 2');
  const parsed = setupV2.safeParse(value);
  if (!parsed.success) throw new UserError(`.apos/project.yaml is not a valid setup: ${describe(parsed.error)}`);
  return { version: 2, setup: parsed.data };
}

/** sha256 of the setup text with line endings normalised, so Windows and Linux checkouts agree. */
export const setupSha256 = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');

export type ParsedSetupText = { version: 1 } | { version: 2; setup: ProjectSetup; sha256: string };

/** Reads the text of `.apos/project.yaml` with the injected codec; `sha256` is of the text, as committed. */
export function parseProjectSetup(text: string, codec: SetupCodec): ParsedSetupText {
  let value: unknown;
  try {
    value = codec.parse(text);
  } catch (error) {
    throw new UserError(
      `.apos/project.yaml cannot be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }
  const parsed = parseSetupObject(value);
  return parsed.version === 1 ? parsed : { ...parsed, sha256: setupSha256(text) };
}
