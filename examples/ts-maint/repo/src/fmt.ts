import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This example has no network and no `npm install`: the dependency is a folder in vendor/ that package.json names
// ("fmt": "file:vendor/fmt-1.0.0"), and it is loaded from there. A real project would just `import ... from 'fmt'`.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinned = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: { fmt: string } })
  .dependencies.fmt;
const target = pathToFileURL(join(root, pinned.replace(/^file:/, ''), 'index.js')).href;

export const fmt = (await import(target)) as { format(cents: number): string };
