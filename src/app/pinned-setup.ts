import { parseProjectSetup, type ProjectSetup } from '../domain/project-setup.js';
import type { SetupCodec } from '../domain/setup-codec.js';
import type { SetupHistory } from '../domain/setup-history.js';
import { InvariantError } from '../domain/errors.js';
import { setupTextAt } from './setup-probe.js';

/**
 * The setup a Goal is pinned to, read from the commit it was approved at, never from the delivery under
 * test. No pin means no setup. A file that no longer matches the approved sha256 is a defect, not a setup.
 */
export function loadPinnedSetup(
  repo: string,
  history: SetupHistory,
  setupVersion: number | undefined,
  codec: SetupCodec,
): ProjectSetup | undefined {
  if (setupVersion === undefined) return undefined;
  const approval = history.approvals.find(item => item.version === setupVersion);
  if (!approval) throw new InvariantError(`Setup version ${setupVersion} was never approved`);
  const parsed = parseProjectSetup(setupTextAt(repo, approval.commit), codec);
  if (parsed.version !== 2 || parsed.sha256 !== approval.sha256)
    throw new InvariantError(`Setup v${setupVersion} at ${approval.commit} no longer matches its approved sha256`);
  return parsed.setup;
}
