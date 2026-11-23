import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { UserError } from '../domain/errors.js';
import { parseProjectSetup } from '../domain/project-setup.js';
import type { SetupCodec } from '../domain/setup-codec.js';
import type { SetupApproved } from '../domain/setup-history.js';
import type { ProjectJournal } from '../store/journal.js';
import { assertGitRoot } from '../store/project-history.js';
import { setupTextAt } from './setup-probe.js';

export type PendingApproval = { commit: string; sha256: string; version: number };

/**
 * Checks everything that can be checked before asking the Human: the commit exists and holds a v2 setup,
 * and a passing probe was recorded for exactly this text. A setup edited after its probe has another sha256,
 * so it is refused here.
 */
export function prepareApproval(
  journal: ProjectJournal,
  repo: string,
  revision: string,
  codec: SetupCodec,
): PendingApproval {
  let commit: string;
  try {
    commit = execFileSync('git', ['-C', assertGitRoot(repo), 'rev-parse', '--verify', `${revision}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new UserError(`${revision} is not a commit in this repo`);
  }
  const parsed = parseProjectSetup(setupTextAt(repo, commit), codec);
  if (parsed.version !== 2) throw new UserError('That commit has no v2 setup to approve');
  const history = journal.setupHistory();
  if (history.latest?.sha256 === parsed.sha256)
    throw new UserError(`This setup is already approved as version ${history.approvals.length}`);
  // Only the latest probe of this exact text at this exact commit counts: a probe elsewhere says nothing here.
  const probe = [...history.probes].reverse().find(item => item.sha256 === parsed.sha256 && item.commit === commit);
  if (!probe)
    throw new UserError(
      `Chưa probe ở commit này (${commit.slice(0, 12)}): the setup text (sha256 ${parsed.sha256.slice(0, 12)}) was changed after its probe, or never probed here. Run apos setup probe --commit ${commit.slice(0, 12)}`,
    );
  if (!probe.ok)
    throw new UserError(
      `The latest probe of this setup at ${commit.slice(0, 12)} failed (${probe.results
        .filter(r => !r.ok)
        .map(r => `${r.part}.${r.layer} ${r.tool}: ${r.reason}`)
        .join('; ')}); fix it and probe again`,
    );
  return { commit, sha256: parsed.sha256, version: history.approvals.length + 1 };
}

export function recordApproval(
  journal: ProjectJournal,
  pending: PendingApproval,
  confirmation: { by: 'human' | 'on-behalf'; onBehalf?: string },
  now: () => string = () => new Date().toISOString(),
): SetupApproved {
  const data: SetupApproved = { ...pending, confirmation };
  journal.appendProjectEvent({ id: randomUUID(), type: 'setup-approved', at: now(), data });
  return data;
}
