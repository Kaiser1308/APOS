import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function saveCheckpoint(directory, row) {
  writeFileSync(join(directory, 'result.json'), JSON.stringify(row, null, 2), { mode: 0o600, flag: 'wx' });
}

export function saveRunIdentity(directory, identity) {
  writeFileSync(join(directory, 'run.json'), JSON.stringify(identity, null, 2), { mode: 0o600, flag: 'wx' });
}
