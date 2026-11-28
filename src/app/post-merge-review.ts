import { reviewTestsCheck, REVIEW_CHECK, type TestSet } from '../domain/assurance.js';
import { reviewOverrideBy } from '../domain/review-tests.js';
import type { CheckResult } from '../domain/gate.js';
import type { LayerId } from '../domain/layers.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import type { GoalState } from '../domain/transitions.js';
import { InvariantError } from '../domain/errors.js';
import { fileAt, sha256Of } from './git-files.js';
import { unverifiable } from './integration-assurance.js';

/** Hold non-waived review evidence to the state already verified, across the merge. */
export function postMergeReview(input: {
  repo: string;
  setup: ProjectSetup;
  state: GoalState;
  head: string;
  verified: string;
  runTests: (
    setup: ProjectSetup,
    wanted: Map<string, { part: string; layer: LayerId }>,
    commit: string,
  ) => { set: TestSet; problems: string[] };
}): CheckResult[] {
  const { repo, setup, state, head, verified } = input;
  const reviews = state.reviewTests ?? [];
  if (!reviews.length) return [];
  const wanted = new Map<string, { part: string; layer: LayerId }>();
  for (const review of reviews) {
    if (reviewOverrideBy(state, review)) continue;
    for (const test of review.tests) wanted.set(`${test.part}.${test.layer}`, { part: test.part, layer: test.layer });
  }
  const delivery = input.runTests(setup, wanted, head);
  if (delivery.problems.length)
    return [unverifiable(REVIEW_CHECK, `the layers did not run: ${delivery.problems.join('; ')}`)];
  const atVerified = reviews.map(review => ({
    ...review,
    files: Object.fromEntries(
      Object.entries(review.files).map(([path, hash]) => {
        if (reviewOverrideBy(state, review)) return [path, hash];
        const content = fileAt(repo, verified, path);
        if (!content) throw new InvariantError(`Cannot read review test ${path} at ${verified}`);
        return [path, sha256Of(content)];
      }),
    ),
  }));
  return [
    reviewTestsCheck({
      reviews: atVerified,
      overriddenBy: review => reviewOverrideBy(state, review),
      deliveryFiles: review =>
        Object.fromEntries(
          Object.keys(review.files).map(path => {
            const content = fileAt(repo, head, path);
            return [path, content ? sha256Of(content) : undefined];
          }),
        ),
      delivery: delivery.set,
    }),
  ];
}
