import { fetchPullRequest } from '../app/pull-request.js';
import { UserError } from '../domain/errors.js';
import type { GoalState } from '../domain/transitions.js';

/**
 * The commit `package submit` gates: the one given with `--commit`, or with `--from-pr` the pull request of the Goal,
 * fetched again. The remote moving the pull request to another commit is not followed silently: the Human or Lead says
 * which commit with `--commit`.
 */
export function commitToSubmit(
  repo: string,
  state: GoalState | undefined,
  flags: { commit?: string; fromPr?: boolean },
): string {
  if (Boolean(flags.commit) === Boolean(flags.fromPr))
    throw new UserError('Give exactly one of --commit <sha> or --from-pr');
  if (flags.commit) return flags.commit;
  const pr = state?.spec.fromPr;
  if (!pr) throw new UserError('--from-pr: this Goal was not opened with `apos maintenance open --from-pr <n>`');
  const sha = fetchPullRequest(repo, pr.remote, pr.number);
  if (sha.toLowerCase() !== pr.sha.toLowerCase())
    throw new UserError(
      `pull request #${pr.number} on ${pr.remote} now points at ${sha}, not at ${pr.sha} that the Goal recorded: read what changed, then pass --commit ${sha} to gate it`,
    );
  return sha;
}
