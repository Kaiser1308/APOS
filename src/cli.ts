#!/usr/bin/env node
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
