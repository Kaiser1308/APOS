import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests must never write controller state into the real ~/.apos.
process.env.APOS_HOME = mkdtempSync(join(tmpdir(), 'apos-home-'));
// Tests run inside Orca terminals; they must not inherit the developer's terminal identity.
delete process.env.ORCA_TERMINAL_HANDLE;
// Skills are published from Custom-Skills; tests use minimal fixtures that declare the same contract.
process.env.APOS_SKILLS = fileURLToPath(new URL('../test-fixtures/skills', import.meta.url));
