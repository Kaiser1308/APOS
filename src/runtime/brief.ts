import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  return { ...DEFAULT_PROFILES, ...readCustom(path) };
}

/** Agent ids Orca launches and APOS has screen rules for; others still launch, with every rule set tried. */
export const KNOWN_AGENTS = ['codex', 'claude', 'antigravity'] as const;
export const ROLES: Role[] = ['lead', 'worker', 'reviewer'];
export type ProfileSource = 'default' | 'runtime.json';

const readCustom = (path: string): Partial<RuntimeProfiles> => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as Partial<RuntimeProfiles> : {};
const writeCustom = (home: string, custom: Partial<RuntimeProfiles>): void => {
  const path = join(home, 'runtime.json');
  if (!Object.keys(custom).length) { if (existsSync(path)) rmSync(path); return; }
  mkdirSync(home, { recursive: true });
  writeFileSync(path, `${JSON.stringify(custom, null, 2)}\n`, 'utf8');
};

export function describeProfiles(home: string | undefined): Record<Role, RuntimeProfile & { source: ProfileSource }> {
  const custom = home ? readCustom(join(home, 'runtime.json')) : {};
  return Object.fromEntries(ROLES.map(role => [role, { ...(custom[role] ?? DEFAULT_PROFILES[role]), source: custom[role] ? 'runtime.json' : 'default' }])) as Record<Role, RuntimeProfile & { source: ProfileSource }>;
}

/** Replaces each role's whole profile: a model or effort of the previous agent never carries over to a new one. */
export function setProfile(home: string, roles: Role[], change: { agent: string; model?: string; effort?: string }): RuntimeProfiles {
  if (change.effort && !change.model) throw new Error('--effort requires --model');
  const custom = readCustom(join(home, 'runtime.json'));
  const profile: RuntimeProfile = { agent: change.agent, ...(change.model ? { model: change.model } : {}), ...(change.effort ? { effort: change.effort } : {}) };
  for (const role of roles) custom[role] = profile;
  writeCustom(home, custom);
  return loadProfiles(home);
}

export function resetProfile(home: string, roles: Role[]): RuntimeProfiles {
  const custom = readCustom(join(home, 'runtime.json'));
  for (const role of roles) delete custom[role];
  writeCustom(home, custom);
  return loadProfiles(home);
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
/**
 * The Lead's brief, dispatched when the Human selects the Goal. The same session plans and, in Solo, delivers:
 * the plan it reasoned about is never handed to a cold owner. execution.md is not cited: the Lead writes the plan,
 * and the controller records it only after this worktree was cut.
 */
export function leadBrief(input: BriefBase & { goalVersion: number; budget?: Budget }): string {
  const apos = `apos --repo "${input.repoPath}"`;
  return [
    `${input.goalId}: APOS Lead for Goal v${input.goalVersion}, attempt 1.`,
    WORKSPACE,
    ...skillLines(input, 'lead'),
    `Contract: .apos/goals/${input.goalId}/goal.md and source.md at base commit ${input.baseCommit}. Decide Solo or Multi-WP under the lead skill.`,
    `Run APOS from this terminal only: ${apos} lead propose --file <execution.json> (leave baseCommit out or set it to ${input.baseCommit}), then ${apos} lead commit ${input.goalId}.`,
    `Solo: once lead commit is accepted you are the owner. Keep going in this same turn: deliver in this worktree and commit your delivery report at ${soloReportPath(input.goalId, 1)}; the controller runs every Goal check itself on your final commit.`,
    'Multi-WP: once lead commit has dispatched the packages, report worker_done and end your turn; APOS wakes you here when there is work.',
    ...(budgetLine(input.budget) ? [budgetLine(input.budget)!] : []),
    'If the controller refuses the plan with needs-decision, report worker_done with failed, naming the refusal, and end your turn: the Human decides and APOS wakes you here.',
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

export function leadWakeBrief(input: { repoPath: string; goalId: string; events: string[]; idempotencyKey: string; phase?: 'plan' | 'multi' }): string {
  const planning = input.phase === 'plan';
  return [
    planning ? `${input.goalId}: APOS Lead wake-up: your plan is not accepted yet.` : `${input.goalId}: APOS Lead wake-up for Multi-WP.`,
    'Events since your last turn:',
    ...input.events.map((item, index) => `(${index + 1}) ${oneLine(item)}`),
    planning
      ? `Continue under ${roleSkill('lead')} with what you already know: revise and resubmit with apos --repo "${input.repoPath}" lead propose / lead commit ${input.goalId}. Solo: once accepted, deliver in this same turn as your first brief said. Report worker_done exactly once.`
      : `Handle them under ${roleSkill('lead')}: answer within the approved Goal, revise packages or integrate, then report worker_done once and end your turn.`,
    `${repoMarker(input.repoPath)} APOS dispatch key: ${input.idempotencyKey}.`
  ].join(' ');
}

/** What a fresh agent takes over: the Lead before or after its plan, the Solo owner, or a package Worker. */
export type HandoffKind = 'lead-plan' | 'solo-owner' | 'lead-multi' | 'worker';
export const handoffRole = (kind: HandoffKind): Role => kind === 'worker' ? 'worker' : 'lead';

/**
 * The brief for an agent that takes over another agent's work on the same worktree (out of quota, or the role's
 * profile changed). It is the role brief in full, skills and activation line included, because the new agent has
 * none of the previous session's memory; never a "continue as before" brief.
 */
export function handoffBrief(input: BriefBase & { kind: HandoffKind; fromAgent?: string; goalVersion: number; attempt: number; packageId?: string; packageVersion?: number; owner?: string; outcome?: string; extra?: string; budget?: Budget }): string {
  const apos = `apos --repo "${input.repoPath}"`;
  const goal = input.goalId;
  const body: Record<HandoffKind, string[]> = {
    'lead-plan': [
      `Contract: .apos/goals/${goal}/goal.md and source.md at base commit ${input.baseCommit}. No plan of yours is accepted yet: decide Solo or Multi-WP under the lead skill.`,
      `Run APOS from this terminal only: ${apos} lead propose --file <execution.json> (leave baseCommit out or set it to ${input.baseCommit}), then ${apos} lead commit ${goal}.`,
      `Solo: once lead commit is accepted you are the owner. Keep going in this same turn and commit your delivery report at ${soloReportPath(goal, input.attempt)}.`,
      'Multi-WP: once lead commit has dispatched the packages, report worker_done and end your turn; APOS wakes you here when there is work.'
    ],
    'solo-owner': [
      `You are the owner of the accepted Solo plan (.apos/goals/${goal}/execution.md). Deliver in this worktree under ${CORE_SKILL}: recheck every acceptance criterion and commit your delivery report at ${soloReportPath(goal, input.attempt)}; the controller runs every Goal check itself on your final commit.`
    ],
    'lead-multi': [
      `You are the Lead of this Multi-WP Goal; its packages run in their own worktrees. See where they stand with ${apos} package list ${goal}, handle what is pending under the lead skill (answer within the approved Goal, revise packages or integrate), then report worker_done once and end your turn; APOS wakes you here when there is work.`
    ],
    worker: [
      `Contract: .apos/goals/${goal}/goal.md, source.md, execution.md and packages/${input.packageId}.md (v${input.packageVersion}). Ownership: ${input.owner} owns this Work Package end to end; deliver ${input.outcome}.`,
      `Commit your delivery report at ${packageReportPath(goal, input.packageId ?? '', input.packageVersion ?? 1, input.attempt)}.`
    ]
  };
  return [
    `${goal}${input.packageId ? `, ${input.packageId}` : ''}: APOS ${handoffRole(input.kind) === 'lead' ? `Lead for Goal v${input.goalVersion}` : 'Worker'}, attempt ${input.attempt}, taking over from a previous agent${input.fromAgent ? ` (${input.fromAgent})` : ''} that stopped before finishing.`,
    WORKSPACE,
    `Your current worktree holds all of its work, including uncommitted changes. Before anything else read git status, git log ${input.baseCommit}..HEAD and the reports under .apos/goals/${goal}/; continue from there and do not start over.`,
    ...skillLines(input, handoffRole(input.kind)),
    ...body[input.kind],
    ...(input.extra ? [`Controller note: ${oneLine(input.extra)}`] : []),
    ...(budgetLine(input.budget) ? [budgetLine(input.budget)!] : []),
    'Follow the injected Orca preamble; report worker_done exactly once with succeeded or failed, then idle. Do not merge.',
    `${repoMarker(input.repoPath)} APOS dispatch key: ${input.idempotencyKey}. APOS base commit: ${input.baseCommit}.`
  ].join(' ');
}
