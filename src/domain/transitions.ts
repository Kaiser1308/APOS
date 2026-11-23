import {
  goalApprovalBlockers,
  goalKind,
  parseAppetite,
  parseExecutionProposal,
  parseGoalSpec,
  type Appetite,
  type ExecutionProposal,
  type GoalSpec,
} from './contracts.js';
import { BUG_APPROVE_VIA } from './bugfix.js';
import { attemptKey, type GateReport, type ManualConfirmation } from './gate.js';
import { parseWorkPackage, validatePackageGraph, type WorkPackageSpec } from './packages.js';
import { parseReview, type ReviewRecord } from './reviews.js';
import { applyIntegrationGateRequest } from './integration-gate.js';
import { applyException, type ExceptionRecord } from './exceptions.js';
import { FLAG_PATTERN } from './goal-flags.js';
import { applyReviewBlocked, type ReviewTestLock } from './review-tests.js';
import { applyTestLockEvent, type TestLock, type TestRevisionPending } from './test-lock.js';
import { LEGACY_EVENT_TYPES, type LegacyEventType } from './legacy-events.js';

/** Every event APOS v3 writes. Anything else is refused on append; legacy types are only ever read back. */
export const GOAL_EVENT_TYPES = [
  'goal-drafted',
  'documents-published',
  'goal-approved',
  'goal-selected',
  'goal-revised',
  'proposal-drafted',
  'proposal-approved',
  'proposal-revised',
  'blocked',
  'unblocked',
  'decision-logged',
  'evidence-submitted',
  'gate-recorded',
  'check-confirmed',
  'appetite-set',
  'merge-authorized',
  'finding-recorded',
  'human-notified',
  'package-added',
  'package-plan-added',
  'package-removed',
  'package-revised',
  'package-submitted',
  'package-gate-recorded',
  'integration-gate-requested',
  'integration-completed',
  'verified',
  'outcome-accepted',
  'outcome-revised',
  'outcome-stopped',
  'review-submitted',
  'review-blocked',
  'merge-completed',
  'tests-locked',
  'tests-revision-pending',
  'exception-approved',
  'close-gate-recorded',
] as const;
export type GoalEventType = (typeof GOAL_EVENT_TYPES)[number];
const WRITABLE: ReadonlySet<string> = new Set(GOAL_EVENT_TYPES);
/** Whether APOS v3 may append an event of this type (an unknown or legacy type never is). */
export const isWritableEventType = (type: string): boolean => WRITABLE.has(type);

/** `type` also covers the legacy names, which are read back from old logs and never written. */
export type GoalEvent = {
  id: string;
  goalId: string;
  type: GoalEventType | LegacyEventType;
  data?: unknown;
  at: string;
};
export type GoalStatus =
  | 'draft'
  | 'approved'
  | 'selected'
  | 'planned'
  /** The plan is committed; a tester's acceptance tests are being written and locked (only for a Goal pinned to a setup). */
  | 'testing'
  | 'executing'
  | 'blocked'
  | 'verified'
  | 'closed'
  | 'stopped'
  /** Recorded by APOS v2 while it dispatched agents: read-only, shown as an archive. */
  | 'legacy';
export type PackageStatus = 'pending' | 'submitted' | 'green' | 'red' | 'needs-human';
export type Blocker = { kind: 'technical' | 'product' | 'external'; note: string };
export type PackageState = {
  spec: WorkPackageSpec;
  status: PackageStatus;
  /** Gate runs that came back red. */
  attempts: number;
  submission?: { commit: string; base: string; by: string };
  gate?: GateReport;
  finding?: string;
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
export type GoalState = {
  spec: GoalSpec;
  status: GoalStatus;
  approvedGoalVersion?: number;
  /** The approved setup version this Goal was pinned to at `goal approve`; absent = no setup, guarantees that depend on one are off. */
  setupVersion?: number;
  /** Flags the Human added at `goal approve --flag` (`mutation`): they come on top of the ones in the Goal document. */
  flags?: string[];
  /** Set when `bug approve` gave gate A, the appetite and gate B in one go: who confirmed, for the assurance table. */
  bugApproval?: { by: string; onBehalf?: string };
  selected: boolean;
  /** When `goal select` happened: the time budget runs from here to `verified`. */
  selectedAt?: string;
  publishedDocuments?: { commit: string; files: Record<string, string> }[];
  proposal?: ExecutionProposal;
  proposalApprovedVersion?: number;
  evidence: unknown[];
  blocker?: Blocker;
  packages?: Record<string, PackageState>;
  integration?: {
    commitRef: string;
    conflictResolution?: string;
    regression?: { result: 'pass'; command: string; artifactRef: string };
  };
  merge?: { sourceRef: string; targetBranch: string; mergeCommit: string };
  reviews: ReviewRecord[];
  /** Latest controller-run gate (Solo: the gate of WP-MAIN); owner-submitted evidence never replaces it. */
  gate?: GateReport;
  /** The commit the Goal was verified on. `outcome close` accepts only this commit. */
  verifiedCommit?: string;
  manualConfirmations?: ManualConfirmation[];
  /** Controller-only budget; never rendered into documents or briefs. */
  appetite?: Appetite;
  /** Created only when the Human chooses to merge after reading the Verification Report. */
  mergeAuthorization?: MergeAuthorization;
  /** Gate rerun at the target branch head after a merge. */
  postMergeGate?: GateReport;
  findings?: Finding[];
  /** The locked acceptance tests: every package is gated on top of this commit. Absent = no test locking. */
  testLock?: TestLock;
  /** How many times the lock was replaced after the first one. */
  testRevisions?: number;
  /** A revision of the locked tests waiting for an approved exception. */
  pendingRevision?: TestRevisionPending;
  exceptions?: ExceptionRecord[];
  /** The tests reviewers added with `apos review block`: locked into the next delivery of their package. */
  reviewTests?: ReviewTestLock[];
  /** The latest run of the close-stage layers on the verified commit (only for a Goal pinned to a setup). */
  closeGate?: GateReport;
  /** For a `legacy` Goal: how its old log ended, so closed Goals still count as closed. */
  legacyOutcome?: 'verified' | 'closed' | 'stopped';
};

/** The Goal's status with an archived Goal's final outcome showing through. */
export const effectiveStatus = (state: GoalState): GoalStatus =>
  state.status === 'legacy' && (state.legacyOutcome === 'closed' || state.legacyOutcome === 'stopped')
    ? state.legacyOutcome
    : state.status;

/** Who confirmed a Human decision, as the log wrote it. */
const confirmationOf = (value: unknown): { by: string; onBehalf?: string } => {
  const raw = (value ?? {}) as { by?: unknown; onBehalf?: unknown };
  return {
    by: typeof raw.by === 'string' ? raw.by : 'human',
    ...(typeof raw.onBehalf === 'string' ? { onBehalf: raw.onBehalf } : {}),
  };
};

/** The implicit package a Solo plan delivers through. */
export const SOLO_PACKAGE_ID = 'WP-MAIN';

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
/** How far past the approved minutes `at` is, as text; undefined while inside the budget (or when there is none). */
export function minutesOverBudget(state: GoalState, at: string): string | undefined {
  if (!state.appetite || !state.selectedAt) return undefined;
  const used = Math.round((Date.parse(at) - Date.parse(state.selectedAt)) / 60_000);
  return used > state.appetite.maxWallMinutes
    ? `${used} min since goal select, approved ${state.appetite.maxWallMinutes} min`
    : undefined;
}

/**
 * Why a verified Goal cannot be closed, empty when it can. Closing needs the commit of the last green gate:
 * the gate of WP-MAIN for Solo, the integration gate for Multi-WP. Nothing, `--on-behalf` included, waives it.
 */
export function closeProblems(state: GoalState): string[] {
  const problems: string[] = [];
  if (state.status !== 'verified') problems.push('Technical verification required');
  const gate = state.gate;
  const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
  if (gate?.result !== 'green' || !same(gate.deliveryCommit, state.verifiedCommit))
    problems.push(
      `The Goal is verified on ${state.verifiedCommit ?? 'no recorded commit'} but the last green gate is ${gate ? `${gate.result} on ${gate.deliveryCommit}` : 'missing'}: close only the commit that passed the gate`,
    );
  if (state.proposal?.mode === 'multi-wp' && !same(state.integration?.commitRef, state.verifiedCommit))
    problems.push('A Multi-WP Goal closes only on its integration commit');
  return problems;
}

export const attemptLimit = (state: GoalState): number => state.appetite?.maxAttempts ?? 3;

const FULL_SHA = /^[0-9a-fA-F]{40,64}$/;

const soloPackage = (goal: GoalSpec, proposal: ExecutionProposal): PackageState => ({
  spec: {
    id: SOLO_PACKAGE_ID,
    goalId: goal.id,
    goalVersion: goal.version,
    version: 1,
    owner: 'lead',
    outcome: goal.outcome,
    scope: goal.scope.length ? goal.scope : ['the whole Goal'],
    exclusions: goal.exclusions,
    dependencies: [],
    interfaces: [`${proposal.id}@v${proposal.version}`],
    acceptance: goal.acceptance.map(item => ({
      id: item.id,
      text: item.text,
      goalAcceptanceId: item.id,
      checkIds: item.checkIds,
    })),
    integration: 'Solo: the package is the whole Goal',
    ...(proposal.paths ? { paths: proposal.paths } : {}),
    ...(proposal.stubPaths ? { stubPaths: proposal.stubPaths } : {}),
    ...(proposal.layers ? { layers: proposal.layers } : {}),
  },
  status: 'pending',
  attempts: 0,
});

/** What a goal-level reset keeps from an earlier life of the Goal. */
const fresh = (spec: GoalSpec, appetite?: Appetite): GoalState => ({
  spec,
  status: 'draft',
  selected: false,
  evidence: [],
  packages: {},
  reviews: [],
  ...(appetite ? { appetite } : {}),
});

/**
 * An archived Goal's remaining events never throw and never change what the Goal is: they only keep its
 * latest spec and how it ended. Old logs replay as they were written.
 */
function applyToLegacy(state: GoalState, event: GoalEvent): GoalState {
  switch (event.type) {
    case 'goal-revised':
      return { ...state, spec: parseGoalSpec(event.data), legacyOutcome: undefined };
    case 'verified':
      return { ...state, legacyOutcome: 'verified' };
    case 'outcome-accepted':
      return { ...state, legacyOutcome: 'closed' };
    case 'outcome-stopped':
      return { ...state, legacyOutcome: 'stopped' };
    case 'outcome-revised':
      return { ...state, legacyOutcome: undefined };
    case 'documents-published': {
      const data = event.data as { commit?: string; files?: Record<string, string> } | undefined;
      return data?.commit && data.files
        ? {
            ...state,
            publishedDocuments: [...(state.publishedDocuments ?? []), { commit: data.commit, files: data.files }],
          }
        : state;
    }
    default:
      return state;
  }
}

/** Packages that must be green before the Goal can be integrated or verified. */
const allGreen = (state: GoalState): boolean => {
  const items = Object.values(state.packages ?? {});
  return items.length > 0 && items.every(item => item.status === 'green');
};

export function applyEvent(state: GoalState | undefined, event: GoalEvent): GoalState {
  requireThat(event.id && event.goalId && !Number.isNaN(Date.parse(event.at)), 'Invalid event identity or timestamp');
  if (event.type === 'goal-drafted') {
    requireThat(!state, 'Goal already exists');
    const spec = parseGoalSpec(event.data);
    requireThat(spec.id === event.goalId, 'Event Goal ID mismatch');
    return fresh(spec);
  }
  requireThat(state, 'Goal does not exist');
  requireThat(state.spec.id === event.goalId, 'Event Goal ID mismatch');
  if (LEGACY_EVENT_TYPES.has(event.type)) return { ...state, status: 'legacy' };
  if (state.status === 'legacy') return applyToLegacy(state, event);
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
    case 'goal-approved': {
      requireThat(state.status === 'draft', 'Goal not awaiting approval');
      const blockers = goalApprovalBlockers(state.spec);
      requireThat(!blockers.length, `Goal not approvable: ${blockers.join('; ')}`);
      const data = event.data as
        | { appetite?: unknown; setupVersion?: unknown; flags?: unknown; via?: unknown; confirmation?: unknown }
        | undefined;
      requireThat(data?.appetite, 'Goal approval must include the Human-approved appetite');
      const setupVersion = data?.setupVersion;
      requireThat(
        setupVersion === undefined || (Number.isInteger(setupVersion) && (setupVersion as number) > 0),
        'Goal approval setupVersion must be a positive integer',
      );
      const flags = data?.flags;
      requireThat(
        flags === undefined ||
          (Array.isArray(flags) && flags.every(flag => typeof flag === 'string' && FLAG_PATTERN.test(flag))),
        'Goal approval flags must be words',
      );
      return {
        ...state,
        ...(Array.isArray(flags) && flags.length ? { flags: flags as string[] } : {}),
        status: 'approved',
        ...(data?.via === BUG_APPROVE_VIA ? { bugApproval: confirmationOf(data.confirmation) } : {}),
        approvedGoalVersion: state.spec.version,
        appetite: parseAppetite(data?.appetite),
        ...(setupVersion === undefined ? {} : { setupVersion: setupVersion as number }),
      };
    }
    case 'goal-selected':
      requireThat(state.approvedGoalVersion === state.spec.version, 'Goal must be approved');
      return { ...state, status: 'selected', selected: true, selectedAt: event.at };
    case 'goal-revised': {
      const spec = parseGoalSpec(event.data);
      requireThat(spec.id === state.spec.id && spec.version > state.spec.version, 'Goal revision must advance version');
      requireThat(goalKind(spec) === goalKind(state.spec), 'A Goal revision cannot change the kind of the Goal');
      return fresh(spec, state.appetite);
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
        merge: undefined,
        blocker: undefined,
        gate: undefined,
        verifiedCommit: undefined,
        manualConfirmations: [],
        testLock: undefined,
        pendingRevision: undefined,
      };
    }
    case 'proposal-approved': {
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
      requireThat(
        !state.proposal.sourceSha256 || state.proposal.sourceSha256 === state.spec.source.sha256,
        'Proposal was planned against a different source snapshot',
      );
      const blockers = goalApprovalBlockers(state.spec);
      requireThat(!blockers.length, `Goal has open questions: ${blockers.join('; ')}`);
      requireThat(state.appetite, 'Approved appetite required before execution');
      if (state.proposal.estimatedCost) {
        const cost = state.proposal.estimatedCost;
        requireThat(
          cost.wallMinutes <= state.appetite.maxWallMinutes,
          `needs-decision: estimated ${cost.wallMinutes} min exceeds the approved appetite`,
        );
      }
      if (state.proposal.mode === 'multi-wp')
        validatePackageGraph(
          state.spec,
          state.proposal,
          Object.values(state.packages ?? {}).map(item => item.spec),
        );
      // The Lead's commit decides whether a tester goes first; old logs carry no such flag and replay as executing.
      const testing = (event.data as { testing?: unknown } | undefined)?.testing === true;
      return {
        ...state,
        proposalApprovedVersion: state.proposal.version,
        status: testing ? 'testing' : 'executing',
        packages:
          state.proposal.mode === 'multi-wp'
            ? state.packages
            : { [SOLO_PACKAGE_ID]: soloPackage(state.spec, state.proposal) },
      };
    }
    case 'package-added':
    case 'package-plan-added': {
      requireThat(
        (event.type === 'package-added'
          ? state.status === 'planned'
          : ['planned', 'executing'].includes(state.status)) && state.proposal?.mode === 'multi-wp',
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
        packages: { ...state.packages, [spec.id]: { spec, status: 'pending', attempts: 0 } },
        ...(data && state.status !== 'planned'
          ? { gate: undefined, integration: undefined, reviews: state.reviews.filter(r => r.subject !== 'goal') }
          : {}),
      };
    }
    case 'package-removed': {
      const data = event.data as { packageId?: string; reason?: unknown };
      const item = state.packages?.[data?.packageId ?? ''];
      requireThat(state.proposal?.mode === 'multi-wp' && state.status === 'executing', 'Active Multi-WP required');
      requireThat(typeof data?.reason === 'string' && data.reason.trim(), 'Package removal reason required');
      requireThat(item && item.status !== 'green', 'Package must not be green');
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
      // A new contract invalidates the package and everything built on it.
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
      const packages = { ...replacement };
      for (const packageId of affected)
        packages[packageId] = {
          spec: packages[packageId].spec,
          status: 'pending',
          attempts: packageId === spec.id ? 0 : packages[packageId].attempts,
        };
      return { ...state, packages, integration: undefined, gate: undefined, evidence: [] };
    }
    case 'package-submitted': {
      requireThat(state.status === 'executing', 'Executing Goal required to submit a package');
      requireThat(
        !minutesOverBudget(state, event.at),
        `The time budget is exhausted: ${minutesOverBudget(state, event.at)}`,
      );
      const data = event.data as { packageId?: string; version?: number; commit?: string; base?: string; by?: string };
      const item = state.packages?.[data?.packageId ?? ''];
      requireThat(item, 'Unknown package');
      requireThat(
        ['pending', 'red', 'needs-human', 'submitted'].includes(item.status),
        `Package ${item.spec.id} is ${item.status}; only a pending, red or needs-human package can be submitted`,
      );
      requireThat(data.version === item.spec.version, 'Submission is for another package version');
      requireThat(FULL_SHA.test(data.commit ?? '') && FULL_SHA.test(data.base ?? ''), 'Full commit hashes required');
      requireThat(data.by?.trim(), 'Submission needs who submitted');
      requireThat(
        item.spec.dependencies.every(dep => state.packages?.[dep]?.status === 'green'),
        'Package dependencies must be green',
      );
      return {
        ...state,
        packages: {
          ...state.packages,
          [item.spec.id]: {
            ...item,
            status: 'submitted',
            submission: { commit: data.commit!, base: data.base!, by: data.by! },
          },
        },
      };
    }
    case 'package-gate-recorded': {
      const data = event.data as { packageId?: string; report?: GateReport; signature?: string };
      const item = state.packages?.[data?.packageId ?? ''];
      requireThat(state.status === 'executing', 'Executing Goal required for a package gate');
      requireThat(
        item?.status === 'submitted' &&
          data.report &&
          data.report.attemptKey === `${item.spec.id}@${item.spec.version}:${item.attempts}` &&
          data.report.deliveryCommit.toLowerCase() === item.submission?.commit.toLowerCase(),
        'Package gate must be for the submitted commit and attempt',
      );
      const report = data.report;
      const solo = state.proposal?.mode !== 'multi-wp';
      if (report.result === 'green') {
        const packages = {
          ...state.packages,
          [item.spec.id]: { ...item, status: 'green' as const, gate: report, finding: undefined },
        };
        // A Solo Goal is the one package: its green gate verifies the Goal in this same event, so no crash between the
        // gate record and a separate `verified` can leave a green package under an executing Goal.
        return solo
          ? { ...state, gate: report, packages, status: 'verified', verifiedCommit: report.deliveryCommit }
          : { ...state, packages };
      }
      const finding = report.checks
        .filter(check => check.status !== 'pass')
        .map(
          check =>
            `${check.checkId} ${check.status}: ${check.reason}${check.newFailures.length ? ` (new: ${check.newFailures.join(', ')})` : ''}`,
        )
        .join('; ');
      if (report.result !== 'red')
        return {
          ...state,
          ...(solo ? { gate: report } : {}),
          packages: { ...state.packages, [item.spec.id]: { ...item, status: 'needs-human', gate: report, finding } },
        };
      const attempts = item.attempts + 1;
      const next: GoalState = {
        ...state,
        ...(solo ? { gate: report } : {}),
        packages: { ...state.packages, [item.spec.id]: { ...item, status: 'red', attempts, gate: report, finding } },
      };
      return attempts > attemptLimit(state)
        ? {
            ...next,
            status: 'blocked',
            blocker: {
              kind: 'technical',
              note: `${item.spec.id} failed its gate ${attempts} times, over the approved limit of ${attemptLimit(state)}`,
            },
          }
        : next;
    }
    case 'blocked':
      requireThat(state.status === 'executing', 'Execution required');
      requireThat(event.data && typeof event.data === 'object', 'Blocker details required');
      return { ...state, status: 'blocked', blocker: event.data as Blocker };
    case 'unblocked':
      requireThat(state.status === 'blocked', 'Blocked Goal required');
      return { ...state, status: 'executing', blocker: undefined };
    case 'decision-logged':
      requireThat(event.data && typeof event.data === 'object', 'Decision details required');
      return state;
    case 'evidence-submitted':
      requireThat(state.status === 'executing', 'Execution required');
      return { ...state, evidence: [...state.evidence, event.data] };
    case 'review-submitted':
      // Advisory since v3: a review no longer gates anything, so it only needs to be well formed.
      return { ...state, reviews: [...state.reviews, parseReview(event.data)] };
    case 'review-blocked':
      return applyReviewBlocked(state, event, attemptLimit(state));
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
          FULL_SHA.test(gate.deliveryCommit ?? '') &&
          FULL_SHA.test(gate.baseCommit ?? ''),
        'Gate report for current Goal version and full commits required',
      );
      requireThat(
        ['green', 'red', 'unverifiable', 'needs-human', 'pending'].includes(gate.result),
        'Gate result required',
      );
      requireThat(gate.attemptKey === attemptKey(state), 'Gate was started for an earlier package attempt; rerun it');
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
        FULL_SHA.test(data.deliveryCommit ?? '') && data.by?.trim() && data.note?.trim(),
        'Manual confirmation needs commit, confirmer and note',
      );
      return { ...state, manualConfirmations: [...(state.manualConfirmations ?? []), data] };
    }
    case 'integration-gate-requested':
      return applyIntegrationGateRequest(state, event);
    case 'integration-completed': {
      requireThat(
        state.status === 'executing' && state.proposal?.mode === 'multi-wp',
        'Executing Multi-WP Goal required',
      );
      requireThat(Object.values(state.packages ?? {}).length >= 2 && allGreen(state), 'All packages must be green');
      const data = event.data as GoalState['integration'];
      requireThat(data && typeof data.commitRef === 'string' && data.commitRef.trim(), 'Integration commit required');
      return { ...state, integration: data };
    }
    case 'verified': {
      // Idempotent for a Solo Goal the green gate already verified.
      const same = (event.data as { deliveryCommit?: string } | undefined)?.deliveryCommit;
      if (
        state.status === 'verified' &&
        state.verifiedCommit &&
        (!same || same.toLowerCase() === state.verifiedCommit.toLowerCase())
      )
        return state;
      requireThat(state.status === 'executing', 'Execution required');
      const multi = state.proposal?.mode === 'multi-wp';
      requireThat(!multi || state.integration, 'Integrated Multi-WP evidence required');
      requireThat(multi || allGreen(state), 'The Solo package must be green');
      const commit = (event.data as { deliveryCommit?: string } | undefined)?.deliveryCommit;
      return { ...state, status: 'verified', ...(commit ? { verifiedCommit: commit } : {}) };
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
    case 'human-notified':
      requireThat(event.data && typeof event.data === 'object', 'Notification details required');
      return state;
    case 'outcome-accepted': {
      const problems = closeProblems(state);
      requireThat(!problems.length, problems.join('; '));
      return { ...state, status: 'closed' };
    }
    case 'outcome-revised':
      requireThat(state.status === 'verified', 'Technical verification required');
      return {
        ...fresh(state.spec, state.appetite),
        findings: [],
        manualConfirmations: [],
      };
    case 'outcome-stopped':
      return { ...state, status: 'stopped' };
    case 'tests-locked':
    case 'tests-revision-pending':
      return applyTestLockEvent(state, event);
    case 'exception-approved':
      return applyException(state, event);
    case 'close-gate-recorded': {
      const gate = event.data as GateReport | undefined;
      requireThat(state.status === 'verified' && state.verifiedCommit, 'The close stage runs on a verified Goal');
      requireThat(
        gate?.phase === 'close' &&
          gate.goalId === state.spec.id &&
          Array.isArray(gate.checks) &&
          gate.deliveryCommit?.toLowerCase() === state.verifiedCommit.toLowerCase(),
        'A close gate must be for the commit the Goal was verified on',
      );
      return { ...state, closeGate: gate };
    }
    default:
      // An event type this version does not know (written by a newer APOS) leaves the state as it was,
      // so a rollback can still replay the log instead of losing every Goal after it.
      return state;
  }
}
