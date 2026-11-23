import { newEvent } from './events.js';
import { INFRA_CHECK, SCOPE_CHECK } from '../domain/assurance.js';
import { UserError } from '../domain/errors.js';
import { AGENT_MAY_APPROVE, EXCEPTION_KINDS, floorRefProblem, type ExceptionKind } from '../domain/exceptions.js';
import { reviewRef } from '../domain/review-tests.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { GoalState } from '../domain/transitions.js';
import type { GoalRepository } from '../ports/goal-repository.js';

export type ExceptionRequest = {
  kind: string;
  /** A package id for `needs-human` and `tests-infra`, a commit for `tests-weakened`. */
  ref: string;
  reason: string;
  /** `agent:<name>`, or `human` with the confirmation `confirmHuman` gave. */
  by: string;
  confirmation?: unknown;
};

/** Records the approvals the Human reserved (spec 7.3): a sensitive file changed, or tests were weakened. */
export class ExceptionService {
  /** `loadSetup` gives the setup a Goal is pinned to: `floor-reduced` is judged against its floor. */
  constructor(
    private readonly store: GoalRepository,
    private readonly loadSetup?: (state: GoalState) => ProjectSetup | undefined,
  ) {}

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
    if (kind === 'needs-human' || kind === 'tests-infra') {
      const waitsOn = kind === 'needs-human' ? SCOPE_CHECK : INFRA_CHECK;
      const item = state.packages?.[request.ref];
      if (!item) throw new UserError(`--ref must be a package of ${goalId} for ${kind} (got ${request.ref})`);
      if (item.status !== 'needs-human' || !item.submission)
        throw new UserError(`${request.ref} is ${item.status}: only a package that needs a human can be approved`);
      if (!item.gate?.checks.some(check => check.checkId === waitsOn && check.status === 'needs-human'))
        throw new UserError(
          `${request.ref} waits for something an exception does not settle (see \`apos inbox\`): only ${kind === 'needs-human' ? `a sensitive-file change (${SCOPE_CHECK})` : `a change to test infrastructure (${INFRA_CHECK})`} is approved with --kind ${kind}`,
        );
      commit = item.submission.commit;
    } else if (kind === 'tests-weakened') {
      const pending = state.pendingRevision;
      if (!pending || pending.commit.toLowerCase() !== request.ref.toLowerCase())
        throw new UserError(
          `--ref must be the commit of a revision waiting for approval${pending ? ` (${pending.commit})` : ': there is none'}`,
        );
      commit = pending.commit;
    } else if (kind === 'review-overridden') {
      const blocks = state.reviewTests ?? [];
      const found = blocks.find(item => reviewRef(item, goalId).toLowerCase() === request.ref.toLowerCase());
      if (!found)
        throw new UserError(
          `--ref for review-overridden is <package>:<review commit> of a review block${blocks.length ? ` (${blocks.map(item => reviewRef(item, goalId)).join(', ')})` : ': there is none'}`,
        );
      commit = found.reviewCommit;
    } else {
      // The reduction is read by every gate that runs after this event; it names no commit of the work, so it carries the one the tests were locked on.
      const setup = this.loadSetup?.(state);
      if (!setup) throw new UserError(`${goalId} has no setup: there is no floor to reduce`);
      const problem = floorRefProblem({
        ref: request.ref,
        goalId,
        packages: Object.keys(state.packages ?? {}),
        setup,
      });
      if (problem) throw new UserError(problem);
      const anchor = state.testLock?.commit ?? state.proposal?.baseCommit;
      if (!anchor) throw new UserError(`${goalId} has no plan yet: reduce the floor once the plan is committed`);
      commit = anchor;
    }
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
