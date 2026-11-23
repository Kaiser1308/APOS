#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { runCli } from './cli-app.js';
export { runCli } from './cli-app.js';

/** Zod puts its issues in `message` as a JSON array; the user should read `path: message` lines instead. */
export function describeError(error: unknown): string {
  if (error instanceof ZodError)
    return error.issues
      .map(issue => `${issue.path.length ? issue.path.join('.') : 'input'}: ${issue.message}`)
      .join('\n');
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `argv1` is this file. `npm link` and `npm install -g` make the bin a symlink, so the paths are
 * compared after resolving links; a path that cannot be resolved falls back to the plain comparison.
 */
export function isEntryPoint(argv1: string | undefined, self: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return resolve(argv1) === self;
  }
}

if (isEntryPoint(process.argv[1], fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
