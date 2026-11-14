import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests must never write controller state into the real ~/.apos.
process.env.APOS_HOME = process.env.APOS_TEST_HOME ?? mkdtempSync(join(tmpdir(), 'apos-home-'));
// Tests run inside Orca terminals; they must not inherit the developer's terminal identity.
delete process.env.ORCA_TERMINAL_HANDLE;
// Tests use the skills bundled in this repo; a developer's APOS_SKILLS must not leak in.
delete process.env.APOS_SKILLS;
