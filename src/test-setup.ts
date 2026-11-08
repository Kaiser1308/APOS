import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests must never write controller state into the real ~/.apos.
process.env.APOS_HOME = mkdtempSync(join(tmpdir(), 'apos-home-'));
