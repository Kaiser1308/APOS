import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Role = 'lead' | 'worker' | 'reviewer';
/** Which agent, model and effort each role runs with. Owners default to Codex terra, the measured configuration. */
export type RuntimeProfile = { agent: string; model?: string; effort?: string };
export type RuntimeProfiles = Record<Role, RuntimeProfile>;
export const DEFAULT_PROFILES: RuntimeProfiles = {
  lead: { agent: 'codex', model: 'gpt-6.1-terra' },
  worker: { agent: 'codex', model: 'gpt-6.1-terra' },
  reviewer: { agent: 'codex', model: 'gpt-6-sol' }
};

/** Profiles override from `<controller home>/runtime.json`, e.g. `{ "reviewer": { "agent": "claude" } }`. */
export function loadProfiles(home: string | undefined): RuntimeProfiles {
  const path = home && join(home, 'runtime.json');
  if (!path || !existsSync(path)) return DEFAULT_PROFILES;
  const custom = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeProfiles>;
  return { ...DEFAULT_PROFILES, ...custom };
}

export const CORE_SKILL = '.apos/skills/_core/execute.md';
export const roleSkill = (role: Role | 'pm') => `.apos/skills/${role}.md`;

/** sha256 of a file as committed at `commit`, so the brief pins exactly what the owner's worktree contains. */
export function committedFileDigest(repoPath: string, commit: string, path: string): string {
  const text = execFileSync('git', ['-C', repoPath, 'show', `${commit}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** The line a delivery report must contain to show the owner loaded this exact core skill. */
export const activationLine = (coreDigest: string) => `apos-core: ${coreDigest.slice(0, 16)}`;

export const soloReportPath = (goalId: string, attempt: number) => `.apos/goals/${goalId}/evidence/solo-a${attempt}.md`;
export const packageReportPath = (goalId: string, packageId: string, version: number, attempt: number) => `.apos/goals/${goalId}/evidence/${packageId}-v${version}-a${attempt}.md`;
export const reviewResultPath = (goalId: string, key: string) => `.apos/goals/${goalId}/reviews/${key.slice(0, 8)}.json`;

/** `digest(path)` returns the sha256 of a file as committed at the base commit. */
const WORKSPACE = 'Work only in your current working directory: the git worktree APOS created for you. Never cd into, edit, or commit to the APOS repo named at the end of this brief; the controller reads your delivery from your own worktree branch.';
export const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, ' / ');
/** Recovery reads the managed repo from this marker; owners are told never to work there. */
export const repoMarker = (repoPath: string) => `APOS repo: <${repoPath}>.`;
export const parseRepoMarker = (spec: string): string | undefined => /APOS repo: <([^>]*)>/.exec(spec)?.[1] ?? /Target: (.*?), (?:GOAL-|APOS Solo Goal)/.exec(spec)?.[1];

/** What the Human's appetite leaves for the owner. Seen live: an owner that did not know it stopped at 15 of 90 minutes. */
export type Budget = { minutesLeft: number; attemptsLeft: number };
export const budgetLine = (budget?: Budget) => budget
  ? `Budget left for this Goal: about ${Math.max(0, Math.round(budget.minutesLeft))} min of wall time and ${budget.attemptsLeft} attempt(s) after this one. Use it: do not stop at partial work or report failed while budget remains, unless the Goal cannot be met within scope (then name the requirement that blocks it and why).`
  : undefined;

type BriefBase = { repoPath: string; goalId: string; baseCommit: string; idempotencyKey: string; digest?: (path: string) => string };

function skillLines(input: BriefBase, role: Role): string[] {
  const digest = input.digest ?? ((path: string) => committedFileDigest(input.repoPath, input.baseCommit, path));
  const core = digest(CORE_SKILL);
  const skill = digest(roleSkill(role));
  return [
    `Read ${CORE_SKILL} (sha256 ${core}) and ${roleSkill(role)} (sha256 ${skill}) before anything else and follow them for the whole attempt (hashes are of the content with LF line endings; a CRLF checkout hashes differently and is not a finding).`,
    `Your delivery report must contain this activation line verbatim: ${activationLine(core)}`
  ];
}

/**
 * Briefs point at committed files by path and hash instead of pasting product text into a shell
 * argument, so quotes, `$` and newlines in a Goal cannot break or alter the dispatch.
 */
export function soloBrief(input: BriefBase & { attempt: number; budget?: Budget }): string {
  return [
    `${input.goalId}: APOS Solo owner, attempt ${input.attempt}.`,
    WORKSPACE,
    ...skillLines(input, 'lead'),
    `Contract: .apos/goals/${input.goalId}/goal.md, source.md and execution.md at base commit ${input.baseCommit}. You own the whole Goal in this worktree.`,
    `Commit your delivery report at ${soloReportPath(input.goalId, input.attempt)}. The controller will run every Goal check itself on your final commit.`,
    ...(budgetLine(input.budget) ? [budgetLine(input.budget)!] : []),
    'Follow the injected Orca preamble; report worker_done exactly once with succeeded or failed, then idle. Do not merge.',
    `${repoMarker(input.repoPath)} APOS dispatch key: ${input.idempotencyKey}. APOS base commit: ${input.baseCommit}.`
  ].join(' ');
}

export function repairBrief(input: { goalId: string; attempt: number; finding: string; idempotencyKey: string; repoPath: string; baseCommit?: string; budget?: Budget }): string {
  return [
    `${input.goalId}: same owner, repair attempt ${input.attempt}.`,
    WORKSPACE,
    `The controller's finding on your last attempt: ${oneLine(input.finding)}`,
    `Fix it under ${CORE_SKILL}. Recheck every acceptance criterion, not only this finding, and commit a new delivery report at ${soloReportPath(input.goalId, input.attempt)} with the same activation line.`,
    ...(budgetLine(input.budget) ? [budgetLine(input.budget)!] : []),
    'Report worker_done exactly once with succeeded or failed.',
    `${repoMarker(input.repoPath)} APOS dispatch key: ${input.idempotencyKey}.${input.baseCommit ? ` APOS base commit: ${input.baseCommit}.` : ''}`
  ].join(' ');
}

export function packageBrief(input: BriefBase & { packageId: string; version: number; owner: string; outcome: string; attempt: number }): string {
  return [
    `${input.goalId}, ${input.packageId}: deliver ${input.outcome}.`,
    WORKSPACE,
    ...skillLines(input, 'worker'),
    `Contract: .apos/goals/${input.goalId}/goal.md, source.md, execution.md and packages/${input.packageId}.md (v${input.version}). Ownership: ${input.owner} owns this Work Package end to end.`,
    `Commit your delivery report at ${packageReportPath(input.goalId, input.packageId, input.version, input.attempt)}.`,
    'Follow the injected Orca preamble; report worker_done exactly once with succeeded or failed, then idle. Do not merge.',
    `${repoMarker(input.repoPath)} APOS dispatch key: ${input.idempotencyKey}. APOS base commit: ${input.baseCommit}.`
  ].join(' ');
}

export function reviewBrief(input: BriefBase & { commit: string; reasons: string[] }): string {
  return [
    `${input.goalId}: independent review of commit ${input.commit} against base ${input.baseCommit}.`,
    WORKSPACE,
    ...skillLines(input, 'reviewer').slice(0, 1),
    `Review is required because: ${input.reasons.join('; ')}.`,
    'The controller gate already ran green on this commit; verification.md may be absent from your worktree and must not be requested, created or cited as a finding.',
    `Write {"result":"pass"|"changes","note":"..."} to ${reviewResultPath(input.goalId, input.idempotencyKey)} and commit only that file. Do not edit the implementation.`,
    'Report worker_done exactly once with succeeded when the review is written.',
    `${repoMarker(input.repoPath)} APOS dispatch key: ${input.idempotencyKey}. APOS base commit: ${input.baseCommit}.`
  ].join(' ');
}

export function leadWakeBrief(input: { repoPath: string; goalId: string; events: string[]; idempotencyKey: string }): string {
  return [
    `${input.goalId}: APOS Lead wake-up for Multi-WP.`,
    'Events since your last turn:',
    ...input.events.map((item, index) => `(${index + 1}) ${oneLine(item)}`),
    `Handle them under ${roleSkill('lead')}: answer within the approved Goal, revise packages or integrate, then report worker_done once and end your turn.`,
    `${repoMarker(input.repoPath)} APOS dispatch key: ${input.idempotencyKey}.`
  ].join(' ');
}
