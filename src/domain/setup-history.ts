import { z } from 'zod';
import { InvariantError } from './errors.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-fA-F]{40,64}$/);

const probeResult = z.object({
  part: z.string().min(1),
  layer: z.string().min(1),
  tool: z.string().min(1),
  ok: z.boolean(),
  /** `no-tests`: the tool ran and said there is no test (a repo with no baseline). It is ok, but only a Human may accept it. */
  outcome: z.enum(['no-tests']).optional(),
  reason: z.string(),
});
export type ProbeResult = z.infer<typeof probeResult>;

const probedData = z.object({ sha256, commit, ok: z.boolean(), results: z.array(probeResult) });
const approvedData = z.object({
  version: z.number().int().positive(),
  sha256,
  commit,
  confirmation: z.object({ by: z.enum(['human', 'on-behalf']), onBehalf: z.string().min(1).optional() }),
  /** `baseline-missing`: approved although the repo has no tests in `baselineMissing` (`<part>.<layer>`): every Goal pinned to it is low assurance. */
  assurance: z.literal('baseline-missing').optional(),
  baselineMissing: z.array(z.string().min(1)).min(1).optional(),
});
export type SetupProbed = z.infer<typeof probedData>;
/** The layers a probe found without tests, as `<part>.<layer>`. */
export const layersWithoutTests = (probe: Pick<SetupProbed, 'results'>): string[] =>
  probe.results.filter(item => item.outcome === 'no-tests').map(item => `${item.part}.${item.layer}`);
export type SetupApproved = z.infer<typeof approvedData>;

export const PROJECT_EVENT_TYPES = ['setup-probed', 'setup-approved'] as const;
export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number];
/** An event on the project-level log (`events/_project.jsonl`), as opposed to a Goal's log. */
export type ProjectEvent = { id: string; type: ProjectEventType; at: string; data: unknown };

export type SetupHistory = { probes: SetupProbed[]; approvals: SetupApproved[]; latest?: SetupApproved };

/**
 * Applies one event to the setup history, refusing what must never be recorded: a malformed payload,
 * an approval whose sha256 has no passing probe, or a version that is not the next one (1, 2, 3 ...).
 */
export function applyProjectEvent(history: SetupHistory, event: ProjectEvent): SetupHistory {
  switch (event.type) {
    case 'setup-probed':
      return { ...history, probes: [...history.probes, probedData.parse(event.data)] };
    case 'setup-approved': {
      const data = approvedData.parse(event.data);
      const probe = [...history.probes]
        .reverse()
        .find(item => item.sha256 === data.sha256 && item.commit === data.commit);
      if (!probe?.ok)
        throw new InvariantError(
          `setup ${data.sha256.slice(0, 12)} was approved without a passing probe at ${data.commit.slice(0, 12)}`,
        );
      const missing = layersWithoutTests(probe);
      if (missing.length && data.assurance !== 'baseline-missing')
        throw new InvariantError(
          `setup ${data.sha256.slice(0, 12)} was probed with no tests in ${missing.join(', ')} but approved without the baseline-missing label`,
        );
      if (data.assurance === 'baseline-missing' && !missing.length)
        throw new InvariantError(
          `setup ${data.sha256.slice(0, 12)} is labelled baseline-missing but its probe found tests`,
        );
      const expected = history.approvals.length + 1;
      if (data.version !== expected)
        throw new InvariantError(`setup approval must be version ${expected}, not ${data.version}`);
      return { ...history, approvals: [...history.approvals, data], latest: data };
    }
    default:
      throw new InvariantError(`unknown project event ${String(event.type)}`);
  }
}

export const replaySetupHistory = (events: ProjectEvent[]): SetupHistory =>
  events.reduce(applyProjectEvent, { probes: [], approvals: [] } as SetupHistory);
