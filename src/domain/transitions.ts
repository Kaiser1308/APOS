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
import { applyLeadTransfer, type LeadBot } from './lead-transfer.js';
import { InvariantError } from './errors.js';
import { applyIntegrationGateRequest } from './integration-gate.js';
import { applyControllerRequest, type PendingRequest } from './controller-requests.js';

/** Replay does not validate: old logs must replay as they are. Narrows event data and nothing else. */
const asRef = <T>(value: unknown): T => value as T;

export type GoalEventType =
  | 'goal-drafted'
  | 'documents-published'
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
  | 'lead-transferred'
  | 'lead-returned'
  | 'lead-bot-checked-in'
  | 'owner-progress-observed'
  | 'verified'
  | 'outcome-accepted'
  | 'outcome-revised'
  | 'outcome-stopped'
  | 'review-submitted'
  | 'merge-completed'
  | 'integration-completed'
  | 'integration-gate-requested'
  | 'controller-requested'
  | 'controller-request-attempted'
  | 'controller-request-settled'
  | 'package-added'
  | 'package-plan-added'
  | 'package-removed'
  | 'package-dispatch-approved'
  | 'package-dispatch-held'
  | 'package-approval-policy-set'
  | 'package-approval-policy-initialized'
  | 'package-failure-decided'
  | 'multi-time-exhausted'
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
  dispatchApproved?: boolean;
  leadDecisionRequired?: boolean;
};
export type GoalState = {
  spec: GoalSpec;
  status: GoalStatus;
  approvedGoalVersion?: number;
  selected: boolean;
  leadApprovalRequired?: boolean;
  multiTimeExhaustedLimit?: number;
  publishedDocuments?: { commit: string; files: Record<string, string> }[];
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
    regression?: { result: 'pass'; command: string; artifactRef: string };
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
  /** The Orca bot holding the Lead role instead of an APOS dispatch (`apos handoff --to-bot`). */
  leadBot?: LeadBot;
  /** Commands that start or move an agent, waiting for the controller, which alone starts workers (`controller-requests.ts`). */
  requests?: PendingRequest[];
};
/**
 * Whose dispatch a handoff replaces: the Goal's Lead (planning, Solo owner or Multi-WP), a package Worker, or the
 * reviewer. `bot` stops the Multi-WP Lead and gives its role to an Orca bot instead of a fresh dispatch.
 */
export type HandoffTarget =
  | { kind: 'lead' }
  | { kind: 'package'; packageId: string }
  | { kind: 'reviewer' }
  | { kind: 'bot'; botId: string; botName: string };
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
/** For guards added or changed since errors were classified: the controller builds these events, so a breach is a defect. */
function invariant(ok: unknown, message: string): asserts ok {
  if (!ok) throw new InvariantError(message);
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
  if (event.type === 'documents-published') {
    const data = event.data as { commit?: unknown; files?: unknown };
    requireThat(typeof data?.commit === 'string' && /^[0-9a-f]{40,64}$/i.test(data.commit), 'Invalid milestone commit');
    requireThat(data.files && typeof data.files === 'object' && !Array.isArray(data.files), 'Invalid milestone files');
    const files = data.files as Record<string, unknown>;
    requireThat(
      Object.entries(files).every(
        ([path, hash]) =>
          path.startsWith(`.apos/goals/${event.goalId}/`) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
      ),
      'Invalid milestone file hash',
    );
    return {
      ...state,
      publishedDocuments: [
        ...(state.publishedDocuments ?? []),
        { commit: data.commit, files: files as Record<string, string> },
      ],
    };
  }
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
      const appetite = parseAppetite(data.appetite);
      return {
        ...state,
        appetite,
        ...(state.appetite?.maxWallMinutes !== appetite.maxWallMinutes ? { multiTimeExhaustedLimit: undefined } : {}),
      };
    }
    case 'multi-time-exhausted': {
      const data = event.data as { limit?: unknown; reason?: unknown };
      requireThat(
        state.proposal?.mode === 'multi-wp' &&
          typeof data?.limit === 'number' &&
          data.limit > 0 &&
          typeof data.reason === 'string' &&
          data.reason.trim(),
        'Multi-WP time limit and reason required',
      );
      return { ...state, multiTimeExhaustedLimit: data.limit };
    }
    case 'package-failure-decided': {
      const data = event.data as { packageId?: string; decision?: string; reason?: unknown };
      const item = state.packages?.[data?.packageId ?? ''];
      requireThat(
        item?.leadDecisionRequired && typeof data.reason === 'string' && data.reason.trim(),
        'Package awaiting Lead decision and reason required',
      );
      requireThat(['retry', 'hold', 'escalate'].includes(data.decision ?? ''), 'Invalid failure decision');
      if (data.decision === 'retry')
        requireThat(item.attempts < attemptLimit(state), 'Human decision required when attempts are exhausted');
      return {
        ...state,
        packages: {
          ...state.packages,
          [item.spec.id]: {
            ...item,
            leadDecisionRequired: data.decision !== 'retry',
            ...(data.decision === 'retry' &&
            item.status === 'blocked' &&
            item.blocker?.note === 'Retry budget exhausted'
              ? { status: 'stale' as const, blocker: undefined }
              : {}),
          },
        },
      };
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
    case 'package-approval-policy-initialized': {
      requireThat(
        state.proposal?.mode === 'multi-wp' &&
          ['ready', 'executing'].includes(state.status) &&
          state.leadApprovalRequired === undefined,
        'Uninitialized Multi-WP approval policy required',
      );
      const packages = { ...state.packages };
      for (const item of Object.values(packages)) {
        const last = item.findings?.at(-1);
        if (
          (item.status === 'stale' || item.status === 'blocked') &&
          (item.gate?.result === 'unverifiable' ||
            (last && item.findings!.filter(value => value === last).length >= 3) ||
            item.attempts >= attemptLimit(state))
        )
          packages[item.spec.id] = { ...item, leadDecisionRequired: true };
      }
      return { ...state, packages, leadApprovalRequired: true };
    }
    case 'package-approval-policy-set': {
      const data = event.data as { enabled?: unknown; reason?: unknown };
      requireThat(
        typeof data?.enabled === 'boolean' && typeof data.reason === 'string' && data.reason.trim(),
        'Approval policy and reason required',
      );
      requireThat(
        state.proposal?.mode === 'multi-wp' && ['ready', 'executing'].includes(state.status),
        'Active Multi-WP required',
      );
      return { ...state, leadApprovalRequired: data.enabled };
    }
    case 'package-dispatch-approved':
    case 'package-dispatch-held': {
      const data = event.data as { packageId?: string; reason?: unknown };
      const item = state.packages?.[data?.packageId ?? ''];
      requireThat(typeof data?.reason === 'string' && data.reason.trim(), 'Lead decision reason required');
      requireThat(
        (item?.status === 'specified' || item?.status === 'stale') &&
          item.spec.dependencies.length &&
          item.spec.dependencies.every(dep => state.packages?.[dep]?.status === 'verified'),
        'Dependency-ready package required',
      );
      return {
        ...state,
        packages: {
          ...state.packages,
          [item.spec.id]: { ...item, dispatchApproved: event.type === 'package-dispatch-approved' },
        },
      };
    }
    case 'package-added':
    case 'package-plan-added': {
      if (event.type === 'package-plan-added')
        requireThat(
          !state.reviewIntent && !state.reviewDispatch,
          'Goal review pending; settle it before changing packages',
        );
      requireThat(
        (event.type === 'package-added'
          ? state.status === 'planned'
          : ['planned', 'ready', 'executing'].includes(state.status)) && state.proposal?.mode === 'multi-wp',
        'Draft Multi-WP proposal required before approval',
      );
      const data =
        event.type === 'package-plan-added' ? (event.data as { spec?: unknown; reason?: unknown }) : undefined;
      if (data) requireThat(typeof data.reason === 'string' && data.reason.trim(), 'Package addition reason required');
      const spec = parseWorkPackage(data ? data.spec : event.data);
      requireThat(
        spec.goalId === state.spec.id && spec.goalVersion === state.spec.version,
        'Package Goal version mismatch',
      );
      requireThat(!state.packages?.[spec.id], `Package ${spec.id} already exists`);
      if (data && state.status !== 'planned')
        validatePackageGraph(state.spec, state.proposal!, [
          ...Object.values(state.packages ?? {}).map(item => item.spec),
          spec,
        ]);
      return {
        ...state,
        packages: { ...state.packages, [spec.id]: { spec, status: 'specified', evidence: [], attempts: 0 } },
        ...(data && state.status !== 'planned'
          ? {
              gate: undefined,
              integration: undefined,
              reviews: state.reviews.filter(review => review.subject !== 'goal'),
            }
          : {}),
      };
    }
    case 'package-removed': {
      requireThat(
        !state.reviewIntent && !state.reviewDispatch,
        'Goal review pending; settle it before changing packages',
      );
      const data = event.data as { packageId?: string; reason?: unknown };
      const item = state.packages?.[data?.packageId ?? ''];
      requireThat(
        state.proposal?.mode === 'multi-wp' && ['ready', 'executing'].includes(state.status),
        'Active Multi-WP required',
      );
      requireThat(typeof data?.reason === 'string' && data.reason.trim(), 'Package removal reason required');
      requireThat(
        item && !['verified', 'dispatching', 'resuming'].includes(item.status),
        'Package must be unverified and settled',
      );
      requireThat(
        !item.runtimeRef || state.settlements?.[item.runtimeRef.dispatchId],
        'Worker settlement must be recorded',
      );
      requireThat(
        !Object.values(state.packages ?? {}).some(other => other.spec.dependencies.includes(item.spec.id)),
        'Package has dependents',
      );
      const packages = { ...state.packages };
      delete packages[item.spec.id];
      validatePackageGraph(
        state.spec,
        state.proposal,
        Object.values(packages).map(other => other.spec),
      );
      return {
        ...state,
        packages,
        gate: undefined,
        integration: undefined,
        reviews: state.reviews.filter(review => review.subject !== 'goal'),
      };
    }
    case 'package-revised': {
      if (state.leadApprovalRequired !== undefined)
        requireThat(
          !state.reviewIntent && !state.reviewDispatch,
          'Goal review pending; settle it before changing packages',
        );
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
        JSON.stringify(spec.acceptance.map(item => item.goalAcceptanceId)) ===
          JSON.stringify(current.spec.acceptance.map(item => item.goalAcceptanceId)),
        'Goal reapproval required for acceptance mapping change',
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
          !['dispatching', 'resuming'].includes(replacement[packageId].status) &&
            (replacement[packageId].status !== 'executing' ||
              Boolean(
                replacement[packageId].runtimeRef && state.settlements?.[replacement[packageId].runtimeRef!.dispatchId],
              )),
          'Settle affected Workers before revising contract',
        );
      const packages = { ...replacement };
      for (const packageId of affected) {
        const item = packages[packageId];
        packages[packageId] = {
          ...item,
          status: item.runtimeRef ? 'stale' : 'specified',
          evidence: [],
          ...(state.leadApprovalRequired !== undefined
            ? {
                dispatchApproved: undefined,
                gate: undefined,
                ...(packageId === spec.id ? { attempts: 0, findings: [], leadDecisionRequired: false } : {}),
              }
            : {}),
        };
      }
      return {
        ...state,
        packages,
        integration: undefined,
        ...(state.leadApprovalRequired !== undefined ? { gate: undefined } : {}),
        evidence: [],
        reviews: state.reviews.filter(review => review.subject === 'package' && !affected.has(review.packageId ?? '')),
      };
    }
    case 'package-dispatch-intended': {
      requireThat(state.status === 'ready' || state.status === 'executing', 'Approved Multi-WP Goal required');
      const data = event.data as { packageId?: string; key?: string };
      const packageState = data && state.packages?.[data.packageId ?? ''];
      requireThat(packageState?.status === 'specified' && data.key, 'Specified package and dispatch key required');
      requireThat(
        packageState.spec.dependencies.every(dep => state.packages?.[dep]?.status === 'verified'),
        'Package dependencies must be verified',
      );
      requireThat(
        !packageState.spec.dependencies.length || state.leadApprovalRequired !== true || packageState.dispatchApproved,
        'Lead approval required before dependent package dispatch',
      );
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
      requireThat(!item.leadDecisionRequired, 'Lead decision required before retry');
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
            ...(state.leadApprovalRequired !== undefined ? { leadDecisionRequired: true } : {}),
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
            ...((data.report.result === 'unverifiable' ||
              (item.findings ?? []).filter(value => value === (data.signature ?? finding)).length >= 2 ||
              item.attempts >= attemptLimit(state)) &&
            state.leadApprovalRequired !== undefined
              ? { leadDecisionRequired: true }
              : {}),
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
      // Solo: the owner is the Lead that planned, never a second session; a bot Lead never codes, so its owner is a
      // separate dispatch the controller started under a dispatch intent.
      if (state.leadBot)
        invariant(
          state.dispatchIntent && (event.data as { dispatchId?: string } | undefined)?.dispatchId,
          'The Solo owner of a bot Lead needs a dispatch intent and its dispatch',
        );
      else
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
      const data = event.data as ManualConfirmation;
      // After a merge the post-merge gate reruns every check on the merge commit, so a verified Goal may be confirmed there.
      const onMergeCommit =
        state.status === 'verified' && !!state.merge && data?.deliveryCommit === state.merge.mergeCommit;
      requireThat(state.status === 'executing' || onMergeCommit, 'Executing Goal required for manual confirmation');
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
      requireThat(data && typeof data.commitRef === 'string' && data.commitRef.trim(), 'Integration commit required');
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
        leadBot: undefined,
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
      invariant(
        data?.key && data.from && data.target && ['lead', 'package', 'reviewer', 'bot'].includes(data.target.kind),
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
      invariant(target.kind !== 'bot', 'A transfer to a bot settles with lead-transferred');
      let next: GoalState = { ...state, handoffIntent: undefined };
      if (target.kind === 'lead' && state.leadBot) {
        // A bot holds the Lead: only the Solo owner it does not code itself can be handed to a fresh agent.
        invariant(state.runtimeRef?.dispatchId === data.from, 'A bot holds this Lead; return it before a Lead handoff');
        next = { ...next, runtimeRef: { ...state.runtimeRef, ...asRef<RuntimeRef>(data.ref) } };
      } else if (target.kind === 'lead') {
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
    case 'integration-gate-requested':
      return applyIntegrationGateRequest(state, event);
    case 'controller-requested':
    case 'controller-request-settled':
      return applyControllerRequest(state, event);
    case 'controller-request-attempted':
      requireThat(event.data && typeof event.data === 'object', 'Request attempt details required');
      return state;
    case 'lead-transferred':
    case 'lead-returned':
      return applyLeadTransfer(state, event);
    case 'lead-bot-checked-in':
      // The bot holding the Lead ran a Lead command: it acks the wakes before it and names its chat's mailbox.
      requireThat(
        state.leadBot && (event.data as { botId?: string } | undefined)?.botId === state.leadBot.id,
        'Only the bot holding the Lead checks in',
      );
      return state;
    case 'human-notified':
      requireThat(event.data && typeof event.data === 'object', 'Notification details required');
      return state;
    case 'owner-progress-observed':
      requireThat(event.data && typeof event.data === 'object', 'Progress observation details required');
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
        leadBot: undefined,
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
