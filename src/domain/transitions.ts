import {
  goalApprovalBlockers,
  parseAppetite,
  parseExecutionProposal,
  parseGoalSpec,
  type Appetite,
  type ExecutionProposal,
  type GoalSpec,
  type PhaseCheckpoint,
} from './contracts.js';
import { attemptKey, type GateReport, type ManualConfirmation } from './gate.js';
import {
  parsePackageEvidence,
  parseWorkPackage,
  validatePackageGraph,
  type PackageEvidence,
  type WorkPackageSpec,
} from './packages.js';
import type { PackageRuntimeRef, RuntimeProfile, RuntimeRef } from './runtime-refs.js';
import { ownerIdentities, parseReview, type ReviewRecord } from './reviews.js';

/** Replay does not validate: old logs must replay as they are. Narrows event data and nothing else. */
const asRef = <T>(value: unknown): T => value as T;

export type GoalEventType =
  | 'goal-drafted'
  | 'goal-approved'
  | 'goal-selected'
  | 'goal-revised'
  | 'proposal-drafted'
  | 'proposal-approved'
  | 'proposal-revised'
  | 'dispatch-intended'
  | 'execution-started'
  | 'resume-intended'
  | 'runtime-resumed'
  | 'checkpointed'
  | 'blocked'
  | 'unblocked'
  | 'decision-logged'
  | 'evidence-submitted'
  | 'worker-settled'
  | 'gate-recorded'
  | 'check-confirmed'
  | 'appetite-set'
  | 'merge-authorized'
  | 'finding-recorded'
  | 'human-notified'
  | 'review-intended'
  | 'review-dispatched'
  | 'telemetry-recorded'
  | 'lead-woken'
  | 'lead-dispatch-intended'
  | 'lead-started'
  | 'lead-settled'
  | 'package-gate-recorded'
  | 'intent-abandoned'
  | 'handoff-intended'
  | 'owner-handed-off'
  | 'verified'
  | 'outcome-accepted'
  | 'outcome-revised'
  | 'outcome-stopped'
  | 'review-submitted'
  | 'merge-completed'
  | 'integration-completed'
  | 'package-added'
  | 'package-revised'
  | 'package-dispatch-intended'
  | 'package-started'
  | 'package-resume-intended'
  | 'package-resumed'
  | 'package-retry-exhausted'
  | 'package-evidence-submitted'
  | 'package-verified'
  | 'package-blocked'
  | 'package-unblocked';
export type GoalEvent = { id: string; goalId: string; type: GoalEventType; data?: unknown; at: string };
export type GoalStatus =
  'draft' | 'approved' | 'selected' | 'planned' | 'ready' | 'executing' | 'blocked' | 'verified' | 'closed' | 'stopped';
export type PackageBlocker = { kind: 'technical' | 'product' | 'external'; note: string };
export type Blocker = PackageBlocker;
export type PackageState = {
  spec: WorkPackageSpec;
  status: 'specified' | 'dispatching' | 'resuming' | 'executing' | 'blocked' | 'verified' | 'stale';
  evidence: PackageEvidence[];
  attempts: number;
  runtimeRef?: PackageRuntimeRef;
  dispatchIntent?: string;
  blocker?: PackageBlocker;
  gate?: GateReport;
  finding?: string;
  findings?: string[];
};
export type GoalState = {
  spec: GoalSpec;
  status: GoalStatus;
  approvedGoalVersion?: number;
  selected: boolean;
  proposal?: ExecutionProposal;
  proposalApprovedVersion?: number;
  evidence: unknown[];
  checkpoint?: PhaseCheckpoint;
  dispatchIntent?: string;
  resumeIntent?: string;
  soloAttempts?: number;
  runtimeRef?: RuntimeRef;
  blocker?: Blocker;
  packages?: Record<string, PackageState>;
  integration?: {
    commitRef: string;
    conflictResolution?: string;
    regression: { result: 'pass'; command: string; artifactRef: string };
  };
  merge?: { sourceRef: string; targetBranch: string; mergeCommit: string };
  reviews: ReviewRecord[];
  settlements?: Record<string, 'completed' | 'failed'>;
  /** Latest controller-run gate; owner-submitted evidence never replaces it. */
  gate?: GateReport;
  manualConfirmations?: ManualConfirmation[];
  /** Controller-only budget; never rendered into documents or briefs. */
  appetite?: Appetite;
  /** Created only when the Human chooses to merge after reading the Verification Report. */
  mergeAuthorization?: MergeAuthorization;
  /** Gate rerun at the target branch head after a merge. */
  postMergeGate?: GateReport;
  findings?: Finding[];
  /** Reviewer session the controller started for the current gated commit. */
  reviewDispatch?: {
    dispatchId: string;
    runId: string;
    key: string;
    commit: string;
    worktreeId?: string;
    terminal?: string;
    requested?: { agent: string; model?: string; effort?: string };
  };
  /** A reviewer start whose Orca outcome is not yet known; recovered by its dispatch key. */
  reviewIntent?: { key: string; commit: string; at: string };
  telemetry?: Telemetry[];
  /** Lead terminal for Multi-WP wake-ups, and events already delivered to it. */
  leadTerminal?: { terminal: string; worktree: string; runId?: string };
  wokenFor?: string[];
  /** A Lead dispatch whose Orca outcome is not yet known; recovered by its key. */
  leadIntent?: string;
  /**
   * The Lead the controller dispatched for this Goal version. `current` is its latest dispatch (start or wake);
   * in Solo that dispatch is the owner. `settled` is set when a turn ended before any plan was accepted.
   */
  lead?: LeadState;
  /** A handoff to another agent in flight: the controller leaves `from` alone until it is handed off or abandoned. */
  handoffIntent?: { key: string; target: HandoffTarget; from: string; at: string; runId?: string; unblock?: boolean };
};
/** Whose dispatch a handoff replaces: the Goal's Lead (planning, Solo owner or Multi-WP), a package Worker, or the reviewer. */
export type HandoffTarget = { kind: 'lead' } | { kind: 'package'; packageId: string } | { kind: 'reviewer' };
export const handingOff = (state: GoalState | undefined): boolean => Boolean(state?.handoffIntent);
export type LeadState = {
  ref: {
    runId: string;
    taskId: string;
    dispatchId: string;
    repoPath: string;
    terminal: string;
    worktreeId: string;
    baseCommit: string;
    requested?: RuntimeProfile;
  };
  current: string;
  settled?: 'completed' | 'failed';
};
export type Telemetry = {
  dispatchId: string;
  role: 'lead' | 'worker' | 'reviewer';
  requestedModel?: string;
  launchedModel?: string | null;
  usage?:
    | { model?: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; sessions: number }
    | 'unknown';
  wallMs?: number;
};
export type MergeAuthorization = {
  goalId: string;
  goalVersion: number;
  integrationCommit: string;
  targetBranch: string;
  scope: 'goal';
  once: true;
  by: string;
};
export type FindingKind = 'intent_gap' | 'bad_plan' | 'patch' | 'defer';
export type Finding = {
  kind: FindingKind;
  note: string;
  checkIds?: string[];
  commit?: string;
  logRefs?: string[];
  by: string;
  signature?: string;
  attempt?: number;
};

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export const attemptLimit = (state: GoalState): number => state.appetite?.maxAttempts ?? 3;

export function applyEvent(state: GoalState | undefined, event: GoalEvent): GoalState {
  requireThat(event.id && event.goalId && !Number.isNaN(Date.parse(event.at)), 'Invalid event identity or timestamp');
  if (event.type === 'goal-drafted') {
    requireThat(!state, 'Goal already exists');
    const spec = parseGoalSpec(event.data);
    requireThat(spec.id === event.goalId, 'Event Goal ID mismatch');
    return { spec, status: 'draft', selected: false, evidence: [], packages: {}, reviews: [] };
  }
  requireThat(state, 'Goal does not exist');
  requireThat(state.spec.id === event.goalId, 'Event Goal ID mismatch');
  requireThat(state.status !== 'closed' && state.status !== 'stopped', 'Goal is terminal');
  switch (event.type) {
    case 'goal-approved':
      requireThat(state.status === 'draft', 'Goal not awaiting approval');
      {
        const blockers = goalApprovalBlockers(state.spec);
        requireThat(!blockers.length, `Goal not approvable: ${blockers.join('; ')}`);
      }
      {
        const appetite = (event.data as { appetite?: unknown } | undefined)?.appetite;
        requireThat(appetite, 'Goal approval must include the Human-approved appetite');
        return {
          ...state,
          status: 'approved',
          approvedGoalVersion: state.spec.version,
          appetite: parseAppetite(appetite),
        };
      }
    case 'goal-selected':
      requireThat(state.approvedGoalVersion === state.spec.version, 'Goal must be approved');
      return { ...state, status: 'selected', selected: true };
    case 'goal-revised': {
      const spec = parseGoalSpec(event.data);
      requireThat(spec.id === state.spec.id && spec.version > state.spec.version, 'Goal revision must advance version');
      return {
        spec,
        status: 'draft',
        selected: false,
        evidence: [],
        packages: {},
        reviews: [],
        appetite: state.appetite,
      };
    }
    case 'appetite-set': {
      const data = event.data as { appetite?: unknown; reason?: unknown };
      requireThat(typeof data?.reason === 'string' && data.reason.trim(), 'Appetite change needs the Human reason');
      return { ...state, appetite: parseAppetite(data.appetite) };
    }
    case 'proposal-drafted':
    case 'proposal-revised': {
      requireThat(state.selected && state.approvedGoalVersion === state.spec.version, 'Select approved Goal first');
      const proposal = parseExecutionProposal(event.data);
      requireThat(
        proposal.goalId === state.spec.id && proposal.goalVersion === state.spec.version,
        'Proposal Goal version mismatch',
      );
      requireThat(!state.proposal || proposal.version > state.proposal.version, 'Proposal version must advance');
      return {
        ...state,
        proposal,
        proposalApprovedVersion: undefined,
        status: 'planned',
        evidence: [],
        packages: event.type === 'proposal-revised' && state.status === 'planned' ? (state.packages ?? {}) : {},
        integration: undefined,
        reviews: [],
        settlements: {},
        merge: undefined,
        soloAttempts: undefined,
        runtimeRef: undefined,
        dispatchIntent: undefined,
        resumeIntent: undefined,
        checkpoint: undefined,
        blocker: undefined,
        gate: undefined,
        manualConfirmations: [],
      };
    }
    case 'proposal-approved':
      requireThat(
        state.status === 'planned' &&
          state.proposal &&
          state.selected &&
          state.proposal.goalVersion === state.spec.version,
        'Current proposal required',
      );
      requireThat(
        state.spec.acceptance.every(item =>
          state.proposal!.acceptanceMapping.some(mapping => mapping.acceptanceId === item.id),
        ),
        'Every Goal acceptance criterion needs a verification mapping',
      );
      requireThat(
        state.proposal.acceptanceMapping.every(mapping =>
          state.spec.acceptance.some(item => item.id === mapping.acceptanceId),
        ),
        'Proposal maps an unknown Goal acceptance criterion',
      );
      // The controller, not the Human, accepts the Lead's plan: these are its machine checks before dispatch.
      requireThat(
        !state.proposal.sourceSha256 || state.proposal.sourceSha256 === state.spec.source.sha256,
        'Proposal was planned against a different source snapshot',
      );
      {
        const blockers = goalApprovalBlockers(state.spec);
        requireThat(!blockers.length, `Goal has open questions: ${blockers.join('; ')}`);
      }
      requireThat(state.appetite, 'Approved appetite required before dispatch');
      if (state.proposal.estimatedCost) {
        const cost = state.proposal.estimatedCost;
        requireThat(
          cost.spendUsd <= state.appetite.maxSpendUsd && cost.wallMinutes <= state.appetite.maxWallMinutes,
          `needs-decision: estimated cost ${cost.spendUsd} USD / ${cost.wallMinutes} min exceeds the approved appetite`,
        );
      }
      if (state.proposal.mode === 'multi-wp')
        validatePackageGraph(
          state.spec,
          state.proposal,
          Object.values(state.packages ?? {}).map(item => item.spec),
        );
      return { ...state, proposalApprovedVersion: state.proposal.version, status: 'ready' };
    case 'worker-settled': {
      requireThat(
        state.status === 'executing' || state.status === 'blocked',
        'Active Goal required for worker settlement',
      );
      const data = event.data as { dispatchId?: unknown; outcome?: unknown };
      requireThat(
        typeof data?.dispatchId === 'string' && (data.outcome === 'completed' || data.outcome === 'failed'),
        'Worker settlement requires Dispatch ID and outcome',
      );
      const refs = [state.runtimeRef, ...Object.values(state.packages ?? {}).map(item => item.runtimeRef)] as {
        dispatchId?: string;
      }[];
      requireThat(
        refs.some(ref => ref?.dispatchId === data.dispatchId),
        'Worker settlement Dispatch does not belong to this Goal',
      );
      requireThat(!state.settlements?.[data.dispatchId], 'Worker settlement already recorded');
      return { ...state, settlements: { ...state.settlements, [data.dispatchId]: data.outcome } };
    }
    case 'package-added': {
      requireThat(
        state.status === 'planned' && state.proposal?.mode === 'multi-wp',
        'Draft Multi-WP proposal required before approval',
      );
      const spec = parseWorkPackage(event.data);
      requireThat(
        spec.goalId === state.spec.id && spec.goalVersion === state.spec.version,
        'Package Goal version mismatch',
      );
      requireThat(!state.packages?.[spec.id], `Package ${spec.id} already exists`);
      return {
        ...state,
        packages: { ...state.packages, [spec.id]: { spec, status: 'specified', evidence: [], attempts: 0 } },
      };
    }
    case 'package-revised': {
      requireThat(
        state.proposal?.mode === 'multi-wp' && state.proposalApprovedVersion === state.proposal.version,
        'Approved Multi-WP proposal required',
      );
      const data = event.data as { spec?: unknown; reason?: unknown };
      requireThat(typeof data?.reason === 'string' && data.reason.trim(), 'Package revision reason required');
      const spec = parseWorkPackage(data.spec);
      const current = state.packages?.[spec.id];
      requireThat(
        current &&
          spec.goalId === state.spec.id &&
          spec.goalVersion === state.spec.version &&
          spec.version > current.spec.version,
        'Current package and newer version required',
      );
      requireThat(spec.owner === current.spec.owner, 'Package owner change requires reassignment');
      requireThat(
        JSON.stringify(spec.scope) === JSON.stringify(current.spec.scope) &&
          JSON.stringify(spec.exclusions) === JSON.stringify(current.spec.exclusions) &&
          JSON.stringify(spec.acceptance.map(item => item.goalAcceptanceId)) ===
            JSON.stringify(current.spec.acceptance.map(item => item.goalAcceptanceId)),
        'Goal reapproval required for product scope or acceptance mapping change',
      );
      const replacement = { ...state.packages, [spec.id]: { ...current, spec } };
      validatePackageGraph(
        state.spec,
        state.proposal,
        Object.values(replacement).map(item => item.spec),
      );
      const affected = new Set([spec.id]);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const item of Object.values(replacement)) {
          if (!affected.has(item.spec.id) && item.spec.dependencies.some(dep => affected.has(dep))) {
            affected.add(item.spec.id);
            expanded = true;
          }
        }
      }
      for (const packageId of affected)
        requireThat(
          !['dispatching', 'executing'].includes(replacement[packageId].status),
          'Settle affected Workers before revising contract',
        );
      const packages = { ...replacement };
      for (const packageId of affected) {
        const item = packages[packageId];
        packages[packageId] = { ...item, status: item.runtimeRef ? 'stale' : 'specified', evidence: [] };
      }
      return {
        ...state,
        packages,
        integration: undefined,
        evidence: [],
        reviews: state.reviews.filter(review => review.subject === 'package' && !affected.has(review.packageId ?? '')),
      };
    }
    case 'package-dispatch-intended': {
      requireThat(state.status === 'ready' || state.status === 'executing', 'Approved Multi-WP Goal required');
      const data = event.data as { packageId?: string; key?: string };
      const packageState = data && state.packages?.[data.packageId ?? ''];
      requireThat(packageState?.status === 'specified' && data.key, 'Specified package and dispatch key required');
      return {
        ...state,
        packages: {
          ...state.packages,
          [data.packageId!]: { ...packageState, status: 'dispatching', dispatchIntent: data.key },
        },
      };
    }
    case 'package-started': {
      const data = event.data as { packageId?: string; ref?: unknown };
      const packageState = data && state.packages?.[data.packageId ?? ''];
      requireThat(packageState?.status === 'dispatching' && data.ref, 'Dispatch intent and runtime reference required');
      return {
        ...state,
        status: 'executing',
        packages: {
          ...state.packages,
          [data.packageId!]: {
            ...packageState,
            status: 'executing',
            runtimeRef: asRef<PackageRuntimeRef>(data.ref),
            dispatchIntent: undefined,
            attempts: packageState.attempts + 1,
          },
        },
      };
    }
    case 'package-resume-intended': {
      const data = event.data as { packageId?: string; key?: string };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(
        item?.status === 'stale' && item.runtimeRef && data.key,
        'Stale package, owner and dispatch key required',
      );
      requireThat(
        item.spec.dependencies.every(dep => state.packages?.[dep]?.status === 'verified'),
        'Package dependencies must be verified',
      );
      return {
        ...state,
        packages: { ...state.packages, [data.packageId!]: { ...item, status: 'resuming', dispatchIntent: data.key } },
      };
    }
    case 'package-resumed': {
      const data = event.data as { packageId?: string; ref?: unknown };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(item?.status === 'resuming' && data.ref, 'Resume intent and new runtime reference required');
      requireThat(item.attempts < attemptLimit(state), 'Package retry budget exhausted');
      return {
        ...state,
        packages: {
          ...state.packages,
          [data.packageId!]: {
            ...item,
            status: 'executing',
            runtimeRef: asRef<PackageRuntimeRef>(data.ref),
            dispatchIntent: undefined,
            attempts: item.attempts + 1,
          },
        },
      };
    }
    case 'package-retry-exhausted': {
      const data = event.data as { packageId?: string };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(item?.status === 'stale' && item.attempts >= attemptLimit(state), 'Exhausted stale package required');
      return {
        ...state,
        packages: {
          ...state.packages,
          [data.packageId!]: {
            ...item,
            status: 'blocked',
            blocker: { kind: 'technical', note: 'Retry budget exhausted' },
          },
        },
      };
    }
    case 'package-blocked': {
      const data = event.data as { packageId?: string; blocker?: PackageBlocker };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(item?.status === 'executing', 'Executing package required');
      requireThat(
        data.blocker &&
          ['technical', 'product', 'external'].includes(data.blocker.kind) &&
          typeof data.blocker.note === 'string' &&
          data.blocker.note.trim(),
        'Valid package blocker required',
      );
      return {
        ...state,
        packages: { ...state.packages, [data.packageId!]: { ...item, status: 'blocked', blocker: data.blocker } },
      };
    }
    case 'package-unblocked': {
      const data = event.data as { packageId?: string; resolution?: string };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(item?.status === 'blocked' && item.blocker, 'Blocked package required');
      requireThat(item.blocker.kind !== 'product', 'Goal reapproval required for product blocker');
      requireThat(typeof data.resolution === 'string' && data.resolution.trim(), 'Blocker resolution required');
      return {
        ...state,
        packages: {
          ...state.packages,
          [data.packageId!]: { ...item, status: 'stale', blocker: undefined, evidence: [] },
        },
        reviews: state.reviews.filter(review => review.packageId !== data.packageId),
      };
    }
    case 'package-gate-recorded': {
      const data = event.data as { packageId?: string; report?: GateReport; signature?: string };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(
        item?.status === 'executing' &&
          data.report &&
          data.report.attemptKey === `${item.spec.id}@${item.spec.version}:${item.attempts}`,
        'Package gate must be for the executing package attempt',
      );
      if (data.report.result === 'green')
        return {
          ...state,
          packages: { ...state.packages, [item.spec.id]: { ...item, gate: data.report, finding: undefined } },
        };
      // A red package gate sends the package back to the same owner with the controller's finding.
      const finding = data.report.checks
        .filter(check => check.status !== 'pass')
        .map(
          check =>
            `${check.checkId} ${check.status}: ${check.reason}${check.newFailures.length ? ` (new: ${check.newFailures.join(', ')})` : ''}`,
        )
        .join('; ');
      return {
        ...state,
        packages: {
          ...state.packages,
          [item.spec.id]: {
            ...item,
            status: 'stale',
            gate: data.report,
            evidence: [],
            finding,
            findings: [...(item.findings ?? []), data.signature ?? finding],
          },
        },
      };
    }
    case 'package-verified': {
      const data = event.data as { packageId?: string };
      const packageState = data && state.packages?.[data.packageId ?? ''];
      requireThat(packageState?.status === 'executing', 'Executing package required');
      const gated = packageState.spec.acceptance.some(item => item.checkIds?.length);
      requireThat(
        !gated || packageState.gate?.result === 'green',
        'Green controller gate on the package head required',
      );
      const latest = new Map(packageState.evidence.map(item => [item.acceptanceId, item]));
      requireThat(
        packageState.spec.acceptance.every(item => latest.get(item.id)?.result === 'pass'),
        'Passing package evidence required',
      );
      return { ...state, packages: { ...state.packages, [data.packageId!]: { ...packageState, status: 'verified' } } };
    }
    case 'package-evidence-submitted': {
      const evidence = parsePackageEvidence(event.data);
      const packageState = state.packages?.[evidence.packageId];
      requireThat(packageState?.status === 'executing', 'Executing package required');
      requireThat(evidence.packageVersion === packageState.spec.version, 'Current package version required');
      requireThat(evidence.owner === packageState.spec.owner, 'Package owner mismatch');
      requireThat(
        packageState.spec.acceptance.some(item => item.id === evidence.acceptanceId),
        'Unknown package acceptance ID',
      );
      return {
        ...state,
        packages: {
          ...state.packages,
          [evidence.packageId]: { ...packageState, evidence: [...packageState.evidence, evidence] },
        },
      };
    }
    case 'execution-started':
      requireThat(
        state.status === 'ready' &&
          state.selected &&
          state.proposal &&
          state.proposalApprovedVersion === state.proposal.version,
        'Approved current proposal required',
      );
      // Solo: the owner is the Lead that planned, never a second session.
      requireThat(
        !state.lead || (event.data as { dispatchId?: string } | undefined)?.dispatchId === state.lead.current,
        'Solo owner must be the current Lead dispatch',
      );
      return {
        ...state,
        status: 'executing',
        runtimeRef: asRef<RuntimeRef>(event.data),
        dispatchIntent: undefined,
        soloAttempts: 1,
      };
    case 'dispatch-intended':
      requireThat(
        state.status === 'ready' &&
          !state.dispatchIntent &&
          state.selected &&
          state.proposalApprovedVersion === state.proposal?.version,
        'Approved current proposal required',
      );
      requireThat(typeof event.data === 'string' && event.data.length > 0, 'Dispatch key required');
      return { ...state, dispatchIntent: event.data };
    case 'runtime-resumed':
      requireThat(
        state.status === 'executing' && state.runtimeRef && state.resumeIntent && event.data,
        'Existing resume intent required',
      );
      requireThat((state.soloAttempts ?? 1) < attemptLimit(state), 'Solo retry budget exhausted');
      return {
        ...state,
        runtimeRef: asRef<RuntimeRef>(event.data),
        resumeIntent: undefined,
        evidence: [],
        reviews: [],
        gate: undefined,
        reviewDispatch: undefined,
        reviewIntent: undefined,
        soloAttempts: (state.soloAttempts ?? 1) + 1,
      };
    case 'resume-intended':
      requireThat(
        state.status === 'executing' &&
          state.runtimeRef &&
          state.checkpoint &&
          !state.resumeIntent &&
          state.proposal?.mode.startsWith('solo'),
        'Solo checkpoint and prior owner required',
      );
      requireThat(typeof event.data === 'string' && event.data.length > 0, 'Resume key required');
      return { ...state, resumeIntent: event.data };
    case 'intent-abandoned': {
      // Only for an intent Orca explicitly refused, or one the Human confirmed has no dispatch.
      const data = event.data as { key?: string; reason?: string };
      requireThat(data?.key && data.reason?.trim(), 'Abandoning an intent needs its key and a reason');
      if (state.resumeIntent === data.key) return { ...state, resumeIntent: undefined };
      if (state.handoffIntent?.key === data.key) return { ...state, handoffIntent: undefined };
      if (state.leadIntent === data.key) return { ...state, leadIntent: undefined };
      if (state.dispatchIntent === data.key && state.status === 'ready') return { ...state, dispatchIntent: undefined };
      // Seen live: a refused package resume left the package 'resuming' forever. It goes back to 'stale' to be retried.
      const resuming = Object.entries(state.packages ?? {}).find(
        ([, item]) => item.status === 'resuming' && item.dispatchIntent === data.key,
      );
      if (resuming)
        return {
          ...state,
          packages: {
            ...state.packages,
            [resuming[0]]: { ...resuming[1], status: 'stale', dispatchIntent: undefined },
          },
        };
      throw new Error('No pending dispatch or resume intent with that key');
    }
    case 'checkpointed':
      requireThat(state.status === 'executing', 'Execution required');
      return { ...state, checkpoint: asRef<PhaseCheckpoint>(event.data) };
    case 'blocked':
      requireThat(state.status === 'executing', 'Execution required');
      requireThat(event.data && typeof event.data === 'object', 'Blocker details required');
      return { ...state, status: 'blocked', blocker: asRef<Blocker>(event.data) };
    case 'unblocked':
      requireThat(state.status === 'blocked', 'Blocked Goal required');
      return { ...state, status: 'executing', blocker: undefined };
    case 'decision-logged':
      requireThat(event.data && typeof event.data === 'object', 'Decision details required');
      return state;
    case 'evidence-submitted':
      requireThat(state.status === 'executing', 'Execution required');
      return { ...state, evidence: [...state.evidence, event.data] };
    case 'review-submitted': {
      requireThat(state.status === 'executing', 'Executing Goal required for review');
      const review = parseReview(event.data);
      if (review.subject === 'package') {
        const item = state.packages?.[review.packageId!];
        requireThat(
          item?.status === 'executing' && item.spec.version === review.packageVersion,
          'Executing current package required for review',
        );
        const owners = ownerIdentities(state, item.spec.id);
        requireThat(!owners.names.includes(review.reviewer.toLowerCase()), 'Reviewer must differ from package owner');
        requireThat(
          !owners.sessions.includes(review.session),
          'Reviewer must use a session separate from the package owner',
        );
        requireThat(
          item.evidence.some(evidence => evidence.commitRef === review.commitRef),
          'Review commit must match package evidence',
        );
        const packages =
          review.result === 'changes'
            ? { ...state.packages, [review.packageId!]: { ...item, status: 'stale' as const, evidence: [] } }
            : state.packages;
        return { ...state, packages, reviews: [...state.reviews, review] };
      }
      requireThat(
        state.proposal?.mode !== 'multi-wp' ||
          Object.values(state.packages ?? {}).every(item => item.status === 'verified'),
        'All packages must be verified before Goal review',
      );
      const owners = ownerIdentities(state);
      requireThat(!owners.names.includes(review.reviewer.toLowerCase()), 'Goal reviewer must differ from Lead owner');
      requireThat(
        !owners.sessions.includes(review.session),
        'Goal reviewer must use a session separate from every owner',
      );
      requireThat(
        state.gate && review.commitRef.toLowerCase() === state.gate.deliveryCommit.toLowerCase(),
        'Goal review must name the commit the controller gated',
      );
      return { ...state, reviews: [...state.reviews, review], reviewDispatch: undefined };
    }
    case 'gate-recorded': {
      const gate = event.data as GateReport;
      if (gate?.phase === 'post-merge') {
        requireThat(state.status === 'verified' && state.merge, 'Post-merge gate needs a completed merge');
        requireThat(
          gate.goalId === state.spec.id &&
            gate.goalVersion === state.spec.version &&
            gate.deliveryCommit === state.merge.mergeCommit,
          'Post-merge gate must run on the merge commit',
        );
        return { ...state, postMergeGate: gate };
      }
      requireThat(state.status === 'executing', 'Executing Goal required for gate');
      requireThat(
        gate &&
          gate.goalId === state.spec.id &&
          gate.goalVersion === state.spec.version &&
          Array.isArray(gate.checks) &&
          /^[0-9a-fA-F]{40,64}$/.test(gate.deliveryCommit ?? '') &&
          /^[0-9a-fA-F]{40,64}$/.test(gate.baseCommit ?? ''),
        'Gate report for current Goal version and full commits required',
      );
      requireThat(['green', 'red', 'unverifiable', 'pending'].includes(gate.result), 'Gate result required');
      requireThat(gate.attemptKey === attemptKey(state), 'Gate was started for an earlier owner attempt; rerun it');
      return { ...state, gate };
    }
    case 'check-confirmed': {
      requireThat(state.status === 'executing', 'Executing Goal required for manual confirmation');
      const data = event.data as ManualConfirmation;
      requireThat(
        state.spec.checks.some(item => item.id === data?.checkId && item.kind === 'manual'),
        'Unknown manual check',
      );
      requireThat(
        /^[0-9a-fA-F]{40,64}$/.test(data.deliveryCommit ?? '') && data.by?.trim() && data.note?.trim(),
        'Manual confirmation needs commit, confirmer and note',
      );
      return { ...state, manualConfirmations: [...(state.manualConfirmations ?? []), data] };
    }
    case 'integration-completed': {
      requireThat(
        state.status === 'executing' && state.proposal?.mode === 'multi-wp',
        'Executing Multi-WP Goal required',
      );
      requireThat(
        Object.values(state.packages ?? {}).length >= 2 &&
          Object.values(state.packages ?? {}).every(item => item.status === 'verified'),
        'All packages must be verified',
      );
      const data = event.data as GoalState['integration'];
      requireThat(
        data &&
          typeof data.commitRef === 'string' &&
          data.commitRef.trim() &&
          data.regression?.result === 'pass' &&
          data.regression.command?.trim() &&
          data.regression.artifactRef?.trim(),
        'Passing integration evidence required',
      );
      return { ...state, integration: data };
    }
    case 'verified':
      requireThat(state.status === 'executing', 'Execution required');
      requireThat(state.proposal?.mode !== 'multi-wp' || state.integration, 'Integrated Multi-WP evidence required');
      return { ...state, status: 'verified' };
    case 'merge-completed': {
      const auth = state.mergeAuthorization;
      requireThat(
        state.status === 'verified' && auth && !state.merge,
        'Verified Goal with unused Human merge authorization required',
      );
      const data = event.data as GoalState['merge'];
      requireThat(data?.sourceRef && data.targetBranch && data.mergeCommit, 'Merge details required');
      requireThat(
        data.sourceRef.toLowerCase() === auth.integrationCommit.toLowerCase() &&
          data.targetBranch === auth.targetBranch &&
          auth.goalVersion === state.spec.version,
        'Merge does not match the Human authorization',
      );
      return { ...state, merge: data };
    }
    case 'merge-authorized': {
      requireThat(
        state.status === 'verified' && !state.mergeAuthorization && !state.merge,
        'Verified Goal without a prior authorization required',
      );
      const data = event.data as MergeAuthorization;
      requireThat(
        state.gate?.result === 'green' &&
          data?.integrationCommit?.toLowerCase() === state.gate.deliveryCommit.toLowerCase(),
        'Authorization must name the commit the controller gated green',
      );
      requireThat(
        data.goalId === state.spec.id &&
          data.goalVersion === state.spec.version &&
          data.scope === 'goal' &&
          data.once === true &&
          data.targetBranch?.trim() &&
          data.by?.trim(),
        'Authorization needs Goal, version, target branch, scope, once and who',
      );
      return { ...state, mergeAuthorization: data };
    }
    case 'finding-recorded': {
      const data = event.data as Finding;
      requireThat(
        data &&
          ['intent_gap', 'bad_plan', 'patch', 'defer'].includes(data.kind) &&
          data.note?.trim() &&
          data.by?.trim(),
        'Finding needs kind, note and who',
      );
      const findings = [...(state.findings ?? []), data];
      // A gap in intent cannot be fixed by retrying: it parks the Goal for PM and Human.
      if (data.kind === 'intent_gap' && state.status === 'executing')
        return { ...state, findings, status: 'blocked', blocker: { kind: 'product', note: data.note } };
      return { ...state, findings };
    }
    case 'review-intended': {
      const data = event.data as GoalState['reviewIntent'];
      requireThat(
        state.status === 'executing' && state.gate?.result === 'green' && !state.reviewDispatch,
        'Green gate without a pending reviewer required',
      );
      requireThat(
        data?.key && data.commit?.toLowerCase() === state.gate.deliveryCommit.toLowerCase(),
        'Review intent must name the gated commit',
      );
      return { ...state, reviewIntent: { ...data, at: event.at } };
    }
    case 'review-dispatched': {
      const data = event.data as GoalState['reviewDispatch'];
      requireThat(
        state.status === 'executing' && state.gate?.result === 'green' && !state.reviewDispatch,
        'Green gate without a pending reviewer required',
      );
      requireThat(
        data?.dispatchId && data.key && data.commit?.toLowerCase() === state.gate.deliveryCommit.toLowerCase(),
        'Reviewer must be dispatched on the gated commit',
      );
      return { ...state, reviewDispatch: data, reviewIntent: undefined };
    }
    case 'telemetry-recorded': {
      const data = event.data as Telemetry;
      requireThat(
        data?.dispatchId && ['lead', 'worker', 'reviewer'].includes(data.role),
        'Telemetry needs Dispatch and role',
      );
      return {
        ...state,
        telemetry: [...(state.telemetry ?? []).filter(item => item.dispatchId !== data.dispatchId), data],
      };
    }
    case 'lead-woken': {
      const data = event.data as {
        dispatchId?: string;
        events?: string[];
        terminal?: string;
        worktree?: string;
        runId?: string;
        requested?: unknown;
      };
      requireThat(Array.isArray(data?.events), 'Woken events required');
      const leadTerminal =
        data.terminal && data.worktree
          ? { terminal: data.terminal, worktree: data.worktree, runId: data.runId }
          : state.leadTerminal;
      // A wake on a changed lead profile starts a fresh agent: remember its terminal and profile, or the next wake hands off again.
      const ref =
        state.lead && data.requested
          ? {
              ...state.lead.ref,
              terminal: data.terminal ?? state.lead.ref.terminal,
              requested: asRef<RuntimeProfile>(data.requested),
            }
          : state.lead?.ref;
      const lead =
        state.lead && data.dispatchId
          ? { ...state.lead, ref: ref!, current: data.dispatchId, settled: undefined }
          : state.lead;
      return { ...state, leadTerminal, lead, wokenFor: [...(state.wokenFor ?? []), ...data.events!] };
    }
    case 'lead-dispatch-intended':
      requireThat(
        state.selected &&
          state.approvedGoalVersion === state.spec.version &&
          ['selected', 'planned', 'ready'].includes(state.status),
        'Approved, selected Goal not yet executing required',
      );
      requireThat(
        !state.leadIntent && (!state.lead || state.lead.settled),
        'A Lead is already dispatched or pending for this Goal',
      );
      requireThat(typeof event.data === 'string' && event.data.length > 0, 'Lead dispatch key required');
      return { ...state, leadIntent: event.data };
    case 'lead-started': {
      const ref = event.data as LeadState['ref'];
      requireThat(state.leadIntent, 'Lead dispatch intent required');
      requireThat(
        ref?.dispatchId &&
          ref.runId &&
          ref.terminal &&
          ref.worktreeId &&
          /^[0-9a-fA-F]{40,64}$/.test(ref.baseCommit ?? ''),
        'Lead start needs Dispatch, Run, terminal, worktree and full base commit',
      );
      return {
        ...state,
        leadIntent: undefined,
        lead: { ref, current: ref.dispatchId },
        leadTerminal: { terminal: ref.terminal, worktree: `id:${ref.worktreeId}`, runId: ref.runId },
        wokenFor: [],
      };
    }
    case 'lead-settled': {
      const data = event.data as { dispatchId?: string; outcome?: string };
      requireThat(
        state.lead && data?.dispatchId === state.lead.current && !state.lead.settled,
        'Settlement must be for the current Lead dispatch',
      );
      requireThat(data.outcome === 'completed' || data.outcome === 'failed', 'Lead settlement outcome required');
      requireThat(
        ['selected', 'planned', 'ready'].includes(state.status),
        'Lead settles on its own only before execution starts',
      );
      return { ...state, lead: { ...state.lead, settled: data.outcome } };
    }
    case 'handoff-intended': {
      const data = event.data as {
        key?: string;
        target?: HandoffTarget;
        from?: string;
        runId?: string;
        unblock?: boolean;
      };
      requireThat(!state.handoffIntent, 'A handoff is already pending for this Goal');
      requireThat(
        !state.resumeIntent &&
          !state.leadIntent &&
          !state.reviewIntent &&
          !(state.status === 'ready' && state.dispatchIntent),
        'Another dispatch intent is pending for this Goal',
      );
      requireThat(
        ['selected', 'planned', 'ready', 'executing', 'blocked'].includes(state.status),
        'Handoff needs a Goal whose owner is running',
      );
      requireThat(
        data?.key && data.from && data.target && ['lead', 'package', 'reviewer'].includes(data.target.kind),
        'Handoff needs key, target and the dispatch it replaces',
      );
      return {
        ...state,
        handoffIntent: {
          key: data.key,
          target: data.target,
          from: data.from,
          at: event.at,
          ...(data.runId ? { runId: data.runId } : {}),
          ...(data.unblock ? { unblock: true } : {}),
        },
      };
    }
    case 'owner-handed-off': {
      // A new agent on the same worktree replaces `from`. It is the same owner continuing: no attempt is spent.
      const data = event.data as {
        key?: string;
        target?: HandoffTarget;
        from?: string;
        ref?: Record<string, unknown> & { dispatchId?: string };
        unblock?: boolean;
      };
      requireThat(
        state.handoffIntent && data?.key === state.handoffIntent.key,
        'Handoff must settle the pending handoff',
      );
      requireThat(
        data.ref?.dispatchId && data.from === state.handoffIntent.from,
        'Handoff needs the new dispatch and the one it replaces',
      );
      const target = state.handoffIntent.target;
      let next: GoalState = { ...state, handoffIntent: undefined };
      if (target.kind === 'lead') {
        requireThat(state.lead, 'Lead handoff needs an APOS-dispatched Lead');
        const prior = state.lead.ref;
        const ref = {
          ...prior,
          runId: String(data.ref.runId ?? prior.runId),
          taskId: String(data.ref.taskId ?? prior.taskId),
          dispatchId: data.ref.dispatchId,
          terminal: String(data.ref.terminal ?? prior.terminal),
          requested: asRef<RuntimeProfile | undefined>(data.ref.requested) ?? prior.requested,
        };
        next = {
          ...next,
          lead: { ref, current: ref.dispatchId },
          leadTerminal: { terminal: ref.terminal, worktree: `id:${ref.worktreeId}`, runId: ref.runId },
        };
        if (state.runtimeRef?.dispatchId === data.from)
          next.runtimeRef = { ...state.runtimeRef, ...ref, owner: 'lead' };
      } else if (target.kind === 'package') {
        const item = state.packages?.[target.packageId];
        requireThat(
          item && item.runtimeRef?.dispatchId === data.from,
          'Package handoff must replace its current Worker',
        );
        next = {
          ...next,
          packages: {
            ...state.packages,
            [target.packageId]: {
              ...item,
              status: 'executing',
              runtimeRef: asRef<PackageRuntimeRef>(data.ref),
              dispatchIntent: undefined,
              ...(data.unblock ? { blocker: undefined } : {}),
            },
          },
        };
      } else {
        requireThat(
          state.reviewDispatch?.dispatchId === data.from,
          'Reviewer handoff must replace the current reviewer',
        );
        next = { ...next, reviewDispatch: asRef<GoalState['reviewDispatch']>(data.ref) };
      }
      if (data.unblock && state.status === 'blocked') next = { ...next, status: 'executing', blocker: undefined };
      return next;
    }
    case 'human-notified':
      requireThat(event.data && typeof event.data === 'object', 'Notification details required');
      return state;
    case 'outcome-accepted':
      requireThat(state.status === 'verified', 'Technical verification required');
      return { ...state, status: 'closed' };
    case 'outcome-revised':
      requireThat(state.status === 'verified', 'Technical verification required');
      return {
        ...state,
        status: 'draft',
        selected: false,
        approvedGoalVersion: undefined,
        proposal: undefined,
        proposalApprovedVersion: undefined,
        evidence: [],
        packages: {},
        integration: undefined,
        reviews: [],
        merge: undefined,
        soloAttempts: undefined,
        runtimeRef: undefined,
        dispatchIntent: undefined,
        resumeIntent: undefined,
        checkpoint: undefined,
        blocker: undefined,
        gate: undefined,
        manualConfirmations: [],
        mergeAuthorization: undefined,
        postMergeGate: undefined,
        findings: [],
        lead: undefined,
        leadIntent: undefined,
        leadTerminal: undefined,
        wokenFor: [],
      };
    case 'outcome-stopped':
      return { ...state, status: 'stopped' };
    default:
      // An event type this version does not know (written by a newer APOS) leaves the state as it was,
      // so a rollback can still replay the log instead of losing every Goal after it.
      return state;
  }
}
