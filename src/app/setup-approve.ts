import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { UserError } from '../domain/errors.js';
import { parseProjectSetup } from '../domain/project-setup.js';
import type { SetupCodec } from '../domain/setup-codec.js';
import { layersWithoutTests, type SetupApproved } from '../domain/setup-history.js';
import type { ProjectJournal } from '../store/journal.js';
import { assertGitRoot } from '../store/project-history.js';
import { setupTextAt } from './setup-probe.js';

export type PendingApproval = {
  commit: string;
  sha256: string;
  version: number;
  /** The layers the probe found without tests, when the Human accepts that with `--baseline-missing`. */
  baselineMissing?: string[];
};

/**
 * Checks everything that can be checked before asking the Human: the commit exists and holds a v2 setup,
 * and a passing probe was recorded for exactly this text. A setup edited after its probe has another sha256,
 * so it is refused here. A probe that found a layer with no tests (`no-tests`) is approved only with `baselineMissing`: a
 * Human accepts a repo with no baseline, knowingly. The same text can be approved again at a later commit when the
 * latest approval was `baseline-missing` and the new probe sees tests: that is how the label goes away.
 */
export function prepareApproval(
  journal: ProjectJournal,
  repo: string,
  revision: string,
  codec: SetupCodec,
  options: { baselineMissing?: boolean } = {},
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
  // Only the latest probe of this exact text at this exact commit counts: a probe elsewhere says nothing here.
  const probe = [...history.probes].reverse().find(item => item.sha256 === parsed.sha256 && item.commit === commit);
  // The same text is approved again only to drop the label: the latest approval is baseline-missing and a probe at this commit finds tests (or is still to be run).
  const mayRelabel =
    history.latest?.assurance === 'baseline-missing' && (!probe || (probe.ok && !layersWithoutTests(probe).length));
  if (history.latest?.sha256 === parsed.sha256 && !mayRelabel)
    throw new UserError(`This setup is already approved as version ${history.approvals.length}`);
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
  const missing = layersWithoutTests(probe);
  if (missing.length && !options.baselineMissing)
    throw new UserError(
      `The probe found no tests in ${missing.join(', ')}: the repo has no baseline, so what the gates prove is weak. A Human can accept that with \`apos setup approve --commit ${commit.slice(0, 12)} --baseline-missing\` (every Goal on this setup is then labelled low assurance), or add tests first`,
    );
  if (options.baselineMissing && !missing.length)
    throw new UserError(
      '--baseline-missing: the probe found tests in every layer, so there is no missing baseline to accept; approve without the flag',
    );
  return {
    commit,
    sha256: parsed.sha256,
    version: history.approvals.length + 1,
    ...(missing.length ? { baselineMissing: missing } : {}),
  };
}

export function recordApproval(
  journal: ProjectJournal,
  pending: PendingApproval,
  confirmation: { by: 'human' | 'on-behalf'; onBehalf?: string },
  now: () => string = () => new Date().toISOString(),
): SetupApproved {
  const data: SetupApproved = {
    version: pending.version,
    sha256: pending.sha256,
    commit: pending.commit,
    confirmation,
    ...(pending.baselineMissing ? { assurance: 'baseline-missing', baselineMissing: pending.baselineMissing } : {}),
  };
  journal.appendProjectEvent({ id: randomUUID(), type: 'setup-approved', at: now(), data });
  return data;
}
