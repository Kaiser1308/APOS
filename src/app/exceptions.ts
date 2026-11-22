import { newEvent } from './events.js';
import { SCOPE_CHECK } from '../domain/assurance.js';
import { UserError } from '../domain/errors.js';
import { AGENT_MAY_APPROVE, EXCEPTION_KINDS, type ExceptionKind } from '../domain/exceptions.js';
import type { GoalRepository } from '../ports/goal-repository.js';

export type ExceptionRequest = {
  kind: string;
  /** A package id for `needs-human`, a commit for `tests-weakened`. */
  ref: string;
  reason: string;
  /** `agent:<name>`, or `human` with the confirmation `confirmHuman` gave. */
  by: string;
  confirmation?: unknown;
};

/** Records the approvals the Human reserved (spec 7.3): a sensitive file changed, or tests were weakened. */
export class ExceptionService {
  constructor(private readonly store: GoalRepository) {}

  approve(goalId: string, request: ExceptionRequest): { kind: ExceptionKind; ref: string; commit: string } {
    const state = this.store.getGoal(goalId);
    if (!state) throw new UserError(`Goal not found: ${goalId}`);
    if (['closed', 'stopped', 'legacy'].includes(state.status)) throw new UserError(`${goalId} is ${state.status}`);
    const kind = EXCEPTION_KINDS.find(item => item === request.kind);
    if (!kind) throw new UserError(`--kind is one of ${EXCEPTION_KINDS.join(', ')}`);
    if (!request.reason.trim()) throw new UserError('--reason is required: the log keeps it');
    if (request.by !== 'human' && !/^agent:\S+$/.test(request.by))
      throw new UserError('--by is agent:<name> (or use --human)');
    if (request.by.startsWith('agent:') && !AGENT_MAY_APPROVE.includes(kind))
      throw new UserError(`An agent cannot approve ${kind}; the Human does, with --human`);
    let commit: string;
    if (kind === 'needs-human') {
      const item = state.packages?.[request.ref];
      if (!item) throw new UserError(`--ref must be a package of ${goalId} for needs-human (got ${request.ref})`);
      if (item.status !== 'needs-human' || !item.submission)
        throw new UserError(`${request.ref} is ${item.status}: only a package that needs a human can be approved`);
      if (!item.gate?.checks.some(check => check.checkId === SCOPE_CHECK && check.status === 'needs-human'))
        throw new UserError(
          `${request.ref} waits for something an exception does not settle (see \`apos inbox\`): only a sensitive-file change (${SCOPE_CHECK}) is approved this way`,
        );
      commit = item.submission.commit;
    } else if (kind === 'tests-weakened') {
      const pending = state.pendingRevision;
      if (!pending || pending.commit.toLowerCase() !== request.ref.toLowerCase())
        throw new UserError(
          `--ref must be the commit of a revision waiting for approval${pending ? ` (${pending.commit})` : ': there is none'}`,
        );
      commit = pending.commit;
    } else
      throw new UserError(
        'floor-reduced is reserved for phase 4: no gate reads it yet, so approving it would change nothing',
      );
    this.store.append(
      newEvent(goalId, 'exception-approved', {
        kind,
        ref: request.ref,
        commit,
        reason: request.reason,
        by: request.by,
        ...(request.confirmation ? { confirmation: request.confirmation } : {}),
      }),
    );
    return { kind, ref: request.ref, commit };
  }
}
