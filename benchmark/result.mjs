import { z } from 'zod';

const gate = z.object({
  command: z.literal('package submit'),
  verdict: z.enum(['green', 'red', 'unverifiable', 'needs-human']),
  evidence: z.array(z.object({ digest: z.string().nullable() })),
  caughtBy: z.string().nullable().optional(),
  reasons: z.array(z.string()).optional(),
  setupVersion: z.number().nullable().optional(),
  goalId: z.string().optional(),
  packageId: z.string().optional(),
  commit: z.string().optional(),
});
export function readGateResult(stdout, exitCode, identity) {
  let decoded;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    throw new Error('APOS returned an invalid package result');
  }
  const parsed = gate.safeParse(decoded);
  if (!parsed.success) throw new Error('APOS returned an invalid package result');
  const result = parsed.data;
  if (
    identity &&
    (result.goalId !== identity.goalId || result.packageId !== identity.packageId || result.commit !== identity.commit)
  )
    throw new Error('APOS result does not identify the requested delivery');
  const expected = result.verdict === 'green' ? 0 : result.verdict === 'red' ? 1 : 3;
  if (exitCode !== expected) throw new Error('APOS exit code disagrees with its verdict');
  const failedChecks = (result.reasons ?? []).flatMap(reason => {
    const match = /^(.+?) fail:/.exec(reason);
    return match ? [match[1]] : [];
  });
  return {
    actualVerdict: result.verdict,
    evidenceDigest: result.evidence.map(item => item.digest),
    caughtBy: failedChecks.length ? failedChecks : (result.caughtBy ?? null),
    setupVersion: result.setupVersion ?? null,
  };
}

export function attachResultDigest(result, digest) {
  return { ...result, evidenceDigest: [...result.evidenceDigest, digest], resultDigest: digest };
}
