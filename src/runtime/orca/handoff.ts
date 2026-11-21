import type { ReviewerRef, RuntimeProfile, RuntimeRef } from '../../domain/runtime-refs.js';
import type { HandoffInput, WakeInput } from '../../ports/runtime.js';
import { handoffBrief, leadWakeBrief, reviewBrief } from '../brief.js';
import { SPILL_LIMIT, launchArgs, type OrcaContext } from './exec.js';
import { extractStartedRef, id, profileChanged } from './parse.js';

/** Starts the role's current profile on an existing worktree and Run with a handoff brief: a fresh agent, never the old terminal. */
export async function handoff(ctx: OrcaContext, input: HandoffInput): Promise<RuntimeRef> {
  ctx.execute(['orchestration', 'run-use', '--id', input.runId]);
  const requested = ctx.profile(input.role);
  const spec = handoffBrief({
    ...input,
    extra: input.packageContract
      ? ctx.spill(
          `The current package contract from the controller: ${JSON.stringify(input.packageContract)}${input.extra ? `; ${input.extra}` : ''}`,
          input.idempotencyKey,
        )
      : input.extra
        ? ctx.spill(input.extra, input.idempotencyKey)
        : undefined,
    digest: path => ctx.fileDigest(input.repoPath, input.baseCommit, path),
  });
  const started = ctx.execute([
    'orchestration',
    'worker-start',
    '--spec',
    spec,
    '--worktree',
    `id:${input.worktreeId}`,
    ...launchArgs(requested),
    '--run',
    input.runId,
  ]);
  const ref = extractStartedRef(started, input.repoPath);
  if (ref.runId !== input.runId) throw new Error('Handed-off agent belongs to an unexpected Run');
  return { ...ref, worktreeId: ref.worktreeId ?? input.worktreeId, baseCommit: input.baseCommit, requested };
}

/** A reviewer gets its own worktree at the gated commit and its own session; it never shares the owner's. */
export async function startReviewer(
  ctx: OrcaContext,
  input: {
    repoPath: string;
    goalId: string;
    baseCommit: string;
    commit: string;
    reasons: string[];
    idempotencyKey: string;
    runId: string;
  },
): Promise<ReviewerRef> {
  ctx.execute(['orchestration', 'run-use', '--id', input.runId]);
  // Pin the reviewer skill at the base commit: the delivery under review must not choose its reviewer's rules.
  const spec = reviewBrief({
    repoPath: input.repoPath,
    goalId: input.goalId,
    baseCommit: input.baseCommit,
    idempotencyKey: input.idempotencyKey,
    commit: input.commit,
    reasons: input.reasons,
    digest: path => ctx.fileDigest(input.repoPath, input.baseCommit, path),
  });
  const requested = ctx.profile('reviewer');
  const started = ctx.execute([
    'orchestration',
    'worker-start',
    '--spec',
    spec,
    '--worktree',
    'new-top-level',
    '--repo',
    `path:${input.repoPath}`,
    '--base-branch',
    input.commit,
    '--name',
    `apos-review-${input.goalId.toLowerCase()}-${input.idempotencyKey.slice(0, 8)}`,
    ...launchArgs(requested),
    '--run',
    input.runId,
  ]);
  const ref = extractStartedRef(started, input.repoPath);
  return { ...ref, owner: 'reviewer', key: input.idempotencyKey, commit: input.commit, requested };
}

export async function wakeLead(
  ctx: OrcaContext,
  input: WakeInput,
): Promise<{ dispatchId: string; terminal?: string; requested?: RuntimeProfile }> {
  if (input.baseCommit && input.worktree.startsWith('id:') && profileChanged(input.requested, ctx.profile('lead'))) {
    // A fresh Lead started for this turn whose response was lost: found by its key, never started twice. A failed
    // lookup is not "nothing started": it throws, and the next tick retries under the same key.
    const found = await ctx.recover(input.idempotencyKey, input.runId);
    if (found) return { dispatchId: found.dispatchId, terminal: found.terminal, requested: ctx.profile('lead') };
    const events = input.events.map((item, index) => `(${index + 1}) ${item}`).join('\n');
    const ref = await ctx.handoff({
      kind: input.phase === 'plan' ? 'lead-plan' : 'lead-multi',
      role: 'lead',
      repoPath: input.repoPath,
      goalId: input.goalId,
      goalVersion: input.goalVersion,
      runId: input.runId,
      worktreeId: input.worktree.slice(3),
      baseCommit: input.baseCommit,
      idempotencyKey: input.idempotencyKey,
      attempt: 1,
      fromAgent: input.requested?.agent,
      extra: `Events since the previous agent's last turn:\n${events}`,
    });
    return { dispatchId: ref.dispatchId, terminal: ref.terminal, requested: ref.requested };
  }
  ctx.execute(['orchestration', 'run-use', '--id', input.runId]);
  const joined = input.events.map((item, index) => `(${index + 1}) ${item}`).join('\n');
  const events =
    joined.length > SPILL_LIMIT
      ? [`${input.events.length} events: ${ctx.spill(joined, input.idempotencyKey)}`]
      : input.events;
  const started = ctx.execute([
    'orchestration',
    'worker-start',
    '--spec',
    leadWakeBrief({ ...input, events, phase: input.phase }),
    '--terminal',
    input.terminal,
    '--worktree',
    input.worktree,
    '--timeout-ms',
    '240000',
    '--run',
    input.runId,
  ]);
  return { dispatchId: id(started.dispatchId, 'Dispatch ID') };
}
