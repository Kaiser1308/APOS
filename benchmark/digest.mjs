import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function corpusDigest(root) {
  const entries = [];
  function visit(relative) {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    } else if (stat.isFile()) {
      entries.push([relative, createHash('sha256').update(readFileSync(path)).digest('hex')]);
    } else throw new Error('corpus must contain only regular files and directories');
  }
  visit('');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
