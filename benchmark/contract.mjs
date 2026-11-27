import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { isolatedPath } from './env.mjs';

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
    dependencyCommits: z.array(z.string().regex(/^[a-f0-9]{40}$/)).optional(),
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

function assertOutsideGit(directory) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', directory, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8',
    env: { ...env, PATH: isolatedPath(env.PATH), LC_ALL: 'C' },
  });
  if (result.status === 0) throw new Error('private benchmark data must be outside Git repositories');
  if (result.status !== 128 || !result.stderr.includes('not a git repository')) {
    throw new Error('could not verify that private benchmark data is outside Git repositories');
  }
}

export function assertPrivateCorpus(corpus) {
  const target = realpathSync(corpus);
  assertOutsideGit(target);
  return target;
}

export function assertPrivateOutput(_root, output) {
  const target = join(realpathSync(dirname(output)), basename(output));
  assertOutsideGit(dirname(target));
  return target;
}
