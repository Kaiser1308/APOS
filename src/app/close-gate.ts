import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { newEvent } from './events.js';
import { UserError } from '../domain/errors.js';
import { attemptKey, summarizeGate, type GateReport } from '../domain/gate.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import type { AssuranceService } from './assurance-service.js';

/**
 * The layers of the close stage, on the commit the Goal was verified on. Recorded as its own event: the Goal is already
 * `verified`, so no delivery gate can be. Without a setup there are no layers and nothing is recorded.
 */
export function recordCloseGate(
  store: GoalRepository,
  goalId: string,
  repoPath: string,
  deps: {
    assurance?: Pick<AssuranceService, 'layerChecks'>;
    inspector: CommitInspector;
    shell: string;
    artifactRoot: string;
    now: () => string;
  },
): GateReport | undefined {
  const state = store.getGoal(goalId);
  if (state?.status !== 'verified' || !state.verifiedCommit)
    throw new UserError('A verified Goal is required for the close stage');
  if (!deps.assurance) return undefined;
  const head = state.verifiedCommit;
  const planBase = state.proposal?.baseCommit;
  const base = state.testLock?.commit ?? planBase;
  const changedFiles = planBase ? deps.inspector.files(repoPath, head, planBase) : [];
  const layered = deps.assurance.layerChecks(state, {
    stage: 'close',
    scope: goalId,
    head,
    base,
    changed: changedFiles,
  });
  if (!layered.layers) return undefined;
  const report: GateReport = {
    gateId: `GATE-${randomUUID()}`,
    goalId,
    goalVersion: state.spec.version,
    sourceSha256: state.spec.source.sha256,
    baseCommit: base ?? head,
    deliveryCommit: head,
    attemptKey: attemptKey(state),
    ...(state.setupVersion === undefined ? {} : { setupVersion: state.setupVersion }),
    phase: 'close',
    layers: layered.layers,
    changedFiles,
    environment: { platform: process.platform, shell: deps.shell, node: process.version },
    checks: layered.checks,
    result: summarizeGate(layered.checks),
    at: deps.now(),
  };
  const dir = join(deps.artifactRoot, goalId, report.gateId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  store.append(newEvent(goalId, 'close-gate-recorded', report, deps.now()));
  return report;
}
