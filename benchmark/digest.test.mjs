import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { corpusDigest } from './digest.mjs';

it('changes when a corpus document changes and refuses symbolic links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-digest-'));
  const file = join(dir, 'oracle.txt');
  writeFileSync(file, 'before');
  const first = corpusDigest(dir);
  writeFileSync(file, 'after');
  assert.notEqual(corpusDigest(dir), first);
  symlinkSync(file, join(dir, 'link'));
  assert.throws(() => corpusDigest(dir));
});
