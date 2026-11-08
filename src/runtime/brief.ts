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
type BriefBase = { repoPath: string; goalId: string; baseCommit: string; idempotencyKey: string; digest?: (path: string) => string };

function skillLines(input: BriefBase, role: Role): string[] {
  const digest = input.digest ?? ((path: string) => committedFileDigest(input.repoPath, input.baseCommit, path));
  const core = digest(CORE_SKILL);
  const skill = digest(roleSkill(role));
  return [
    `Read ${CORE_SKILL} (sha256 ${core}) and ${roleSkill(role)} (sha256 ${skill}) before anything else and follow them for the whole attempt.`,
    `Your delivery report must contain this activation line verbatim: ${activationLine(core)}`
  ];
}

/**
 * Briefs point at committed files by path and hash instead of pasting product text into a shell
 * argument, so quotes, `$` and newlines in a Goal cannot break or alter the dispatch.
 */
export function soloBrief(input: BriefBase & { attempt: number }): string {
  return [
    `Target: ${input.repoPath}, ${input.goalId}. APOS Solo owner, attempt ${input.attempt}.`,
    ...skillLines(input, 'lead'),
    `Contract: .apos/goals/${input.goalId}/goal.md, source.md and execution.md at base commit ${input.baseCommit}. You own the whole Goal in this worktree.`,
    `Commit your delivery report at ${soloReportPath(input.goalId, input.attempt)}. The controller will run every Goal check itself on your final commit.`,
    'Follow the injected Orca preamble; report worker_done exactly once with succeeded or failed, then idle. Do not merge.',
    `APOS dispatch key: ${input.idempotencyKey}. APOS base commit: ${input.baseCommit}.`
  ].join('\n');
}

export function repairBrief(input: { goalId: string; attempt: number; finding: string; idempotencyKey: string; repoPath: string; baseCommit?: string }): string {
  return [
    `Target: ${input.repoPath}, ${input.goalId}. Same owner, repair attempt ${input.attempt}.`,
    'The controller ran the Goal checks itself on your last commit. Its finding, from the logs:',
    input.finding,
    `Fix it under ${CORE_SKILL}. Recheck every acceptance criterion, not only this finding, and commit a new delivery report at ${soloReportPath(input.goalId, input.attempt)} with the same activation line.`,
    'Report worker_done exactly once with succeeded or failed.',
    `APOS dispatch key: ${input.idempotencyKey}.${input.baseCommit ? ` APOS base commit: ${input.baseCommit}.` : ''}`
  ].join('\n');
}

export function packageBrief(input: BriefBase & { packageId: string; version: number; owner: string; outcome: string; attempt: number }): string {
  return [
    `Target: ${input.repoPath}, ${input.goalId}, ${input.packageId}. Change: deliver ${input.outcome}.`,
    ...skillLines(input, 'worker'),
    `Contract: .apos/goals/${input.goalId}/goal.md, source.md, execution.md and packages/${input.packageId}.md (v${input.version}). Ownership: ${input.owner} owns this Work Package end to end.`,
    `Commit your delivery report at ${packageReportPath(input.goalId, input.packageId, input.version, input.attempt)}.`,
    'Follow the injected Orca preamble; report worker_done exactly once with succeeded or failed, then idle. Do not merge.',
    `APOS dispatch key: ${input.idempotencyKey}. APOS base commit: ${input.baseCommit}.`
  ].join('\n');
}

export function reviewBrief(input: BriefBase & { commit: string; reasons: string[] }): string {
  return [
    `Target: ${input.repoPath}, ${input.goalId}. Independent review of commit ${input.commit} against base ${input.baseCommit}.`,
    ...skillLines(input, 'reviewer').slice(0, 1),
    `Review is required because: ${input.reasons.join('; ')}.`,
    `Write {"result":"pass"|"changes","note":"..."} to ${reviewResultPath(input.goalId, input.idempotencyKey)} and commit only that file. Do not edit the implementation.`,
    'Report worker_done exactly once with succeeded when the review is written.',
    `APOS dispatch key: ${input.idempotencyKey}. APOS base commit: ${input.baseCommit}.`
  ].join('\n');
}

export function leadWakeBrief(input: { repoPath: string; goalId: string; events: string[]; idempotencyKey: string }): string {
  return [
    `Target: ${input.repoPath}, ${input.goalId}. APOS Lead wake-up for Multi-WP.`,
    'Events since your last turn:',
    ...input.events.map(item => `- ${item}`),
    `Handle them under ${roleSkill('lead')}: answer within the approved Goal, revise packages or integrate, then report worker_done once and end your turn.`,
    `APOS dispatch key: ${input.idempotencyKey}.`
  ].join('\n');
}
