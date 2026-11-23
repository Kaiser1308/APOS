import { execFileSync } from 'node:child_process';
import { scanTwice } from '../app/maintenance-gate.js';
import type { GoalSpec } from '../domain/contracts.js';
import { UserError } from '../domain/errors.js';
import { matchSecurity } from '../domain/findings.js';
import { scanTools } from '../domain/maintenance.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { Finding } from '../domain/results/index.js';
import type { ProjectJournal } from '../store/journal.js';
import type { CliContext } from './context.js';
import { runnerFor } from './test-lock-wiring.js';

export type Baseline = NonNullable<GoalSpec['baseline']>;

/**
 * What the scans of the setup show on the commit the Goal is opened on, each run twice. Recorded once in the Goal, so the
 * gate and the table do not scan the base again. A scan that did not run is left out of the record (the gate scans the
 * base itself); `problems` says why, and a security Goal refuses to open on them.
 */
export function scanBaseline(
  ctx: CliContext,
  journal: ProjectJournal,
  goalId: string,
  setup: ProjectSetup,
  part: string | undefined,
): { baseline?: Baseline; findings: Finding[]; problems: string[] } {
  const tools = scanTools(setup, part);
  if (!tools.length) return { findings: [], problems: [] };
  const commit = execFileSync('git', ['-C', ctx.repo(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const runner = runnerFor(ctx, journal, goalId, 'baseline');
  const scans: Baseline['scans'] = [];
  const problems: string[] = [];
  const findings: Finding[] = [];
  for (const { part: name, tool, key } of tools) {
    const got = scanTwice(runner, commit, tool, setup.parts[name]!.root, `${name}.L5 ${tool.id}`);
    if ('problem' in got) {
      problems.push(got.problem);
      continue;
    }
    findings.push(...got.findings);
    scans.push({
      tool: key,
      command: tool.command,
      findings: got.findings.map(({ fingerprint, ruleId, level, file }) => ({
        fingerprint,
        ruleId,
        level,
        ...(file === undefined ? {} : { file }),
      })),
    });
  }
  return { ...(scans.length ? { baseline: { commit, scans } } : {}), findings, problems };
}

/** The fingerprints `--security` names, each found on the base scan; a refusal lists what did not match. */
export function resolveSecurity(tokens: string[], findings: Finding[]): string[] {
  const refused: string[] = [];
  const prints: string[] = [];
  for (const token of tokens) {
    const match = matchSecurity(findings, token);
    if (match.ok) prints.push(match.finding.fingerprint);
    else refused.push(match.reason);
  }
  if (refused.length) throw new UserError(refused.join('\n'));
  return [...new Set(prints)];
}
