import { parseExecutionProposal, parseGoalSpec, type ExecutionProposal, type GoalSpec } from './contracts.js';
import { parsePackageEvidence, parseWorkPackage, validatePackageGraph, type PackageEvidence, type WorkPackageSpec } from './packages.js';

export type GoalEventType =
  | 'goal-drafted' | 'goal-approved' | 'goal-selected' | 'goal-revised'
  | 'proposal-drafted' | 'proposal-approved' | 'proposal-revised'
  | 'dispatch-intended' | 'execution-started' | 'runtime-resumed' | 'checkpointed' | 'blocked' | 'unblocked' | 'decision-logged' | 'evidence-submitted'
  | 'verified' | 'outcome-accepted' | 'outcome-revised' | 'outcome-stopped' | 'package-added' | 'package-revised' | 'package-dispatch-intended' | 'package-started' | 'package-resume-intended' | 'package-resumed' | 'package-evidence-submitted' | 'package-verified' | 'package-blocked' | 'package-unblocked';
export type GoalEvent = { id: string; goalId: string; type: GoalEventType; data?: unknown; at: string };
export type GoalStatus = 'draft' | 'approved' | 'selected' | 'planned' | 'ready' | 'executing' | 'blocked' | 'verified' | 'closed' | 'stopped';
export type PackageBlocker = { kind: 'technical' | 'product' | 'external'; note: string };
export type PackageState = { spec: WorkPackageSpec; status: 'specified' | 'dispatching' | 'resuming' | 'executing' | 'blocked' | 'verified' | 'stale'; evidence: PackageEvidence[]; runtimeRef?: unknown; dispatchIntent?: string; blocker?: PackageBlocker };
export type GoalState = {
  spec: GoalSpec;
  status: GoalStatus;
  approvedGoalVersion?: number;
  selected: boolean;
  proposal?: ExecutionProposal;
  proposalApprovedVersion?: number;
  evidence: unknown[];
  checkpoint?: unknown;
  dispatchIntent?: string;
  runtimeRef?: unknown;
  blocker?: unknown;
  packages?: Record<string, PackageState>;
};

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

export function applyEvent(state: GoalState | undefined, event: GoalEvent): GoalState {
  requireThat(event.id && event.goalId && !Number.isNaN(Date.parse(event.at)), 'Invalid event identity or timestamp');
  if (event.type === 'goal-drafted') {
    requireThat(!state, 'Goal already exists');
    const spec = parseGoalSpec(event.data);
    requireThat(spec.id === event.goalId, 'Event Goal ID mismatch');
    return { spec, status: 'draft', selected: false, evidence: [], packages: {} };
  }
  requireThat(state, 'Goal does not exist');
  requireThat(state.spec.id === event.goalId, 'Event Goal ID mismatch');
  requireThat(state.status !== 'closed' && state.status !== 'stopped', 'Goal is terminal');
  switch (event.type) {
    case 'goal-approved':
      requireThat(state.status === 'draft', 'Goal not awaiting approval');
      return { ...state, status: 'approved', approvedGoalVersion: state.spec.version };
    case 'goal-selected':
      requireThat(state.approvedGoalVersion === state.spec.version, 'Goal must be approved');
      return { ...state, status: 'selected', selected: true };
    case 'goal-revised': {
      const spec = parseGoalSpec(event.data);
      requireThat(spec.id === state.spec.id && spec.version > state.spec.version, 'Goal revision must advance version');
      return { spec, status: 'draft', selected: false, evidence: [], packages: {} };
    }
    case 'proposal-drafted':
    case 'proposal-revised': {
      requireThat(state.selected && state.approvedGoalVersion === state.spec.version, 'Select approved Goal first');
      const proposal = parseExecutionProposal(event.data);
      requireThat(proposal.goalId === state.spec.id && proposal.goalVersion === state.spec.version, 'Proposal Goal version mismatch');
      requireThat(!state.proposal || proposal.version > state.proposal.version, 'Proposal version must advance');
      return { ...state, proposal, proposalApprovedVersion: undefined, status: 'planned', evidence: [], packages: {} };
    }
    case 'proposal-approved':
      requireThat(state.proposal && state.selected && state.proposal.goalVersion === state.spec.version, 'Current proposal required');
      return { ...state, proposalApprovedVersion: state.proposal.version, status: 'ready' };
    case 'package-added': {
      requireThat(state.status === 'ready' && state.proposal?.mode === 'multi-wp', 'Approved Multi-WP proposal required');
      const spec = parseWorkPackage(event.data);
      requireThat(spec.goalId === state.spec.id && spec.goalVersion === state.spec.version, 'Package Goal version mismatch');
      requireThat(!state.packages?.[spec.id], `Package ${spec.id} already exists`);
      return { ...state, packages: { ...state.packages, [spec.id]: { spec, status: 'specified', evidence: [] } } };
    }
    case 'package-revised': {
      requireThat(state.proposal?.mode === 'multi-wp' && state.proposalApprovedVersion === state.proposal.version, 'Approved Multi-WP proposal required');
      const data = event.data as { spec?: unknown; reason?: unknown };
      requireThat(typeof data?.reason === 'string' && data.reason.trim(), 'Package revision reason required');
      const spec = parseWorkPackage(data.spec);
      const current = state.packages?.[spec.id];
      requireThat(current && spec.goalId === state.spec.id && spec.goalVersion === state.spec.version && spec.version > current.spec.version, 'Current package and newer version required');
      requireThat(spec.owner === current.spec.owner, 'Package owner change requires reassignment');
      requireThat(JSON.stringify(spec.scope) === JSON.stringify(current.spec.scope) && JSON.stringify(spec.exclusions) === JSON.stringify(current.spec.exclusions) && JSON.stringify(spec.acceptance.map(item => item.goalAcceptanceId)) === JSON.stringify(current.spec.acceptance.map(item => item.goalAcceptanceId)), 'Goal reapproval required for product scope or acceptance mapping change');
      const replacement = { ...state.packages, [spec.id]: { ...current, spec } };
      validatePackageGraph(state.spec, state.proposal, Object.values(replacement).map(item => item.spec));
      const affected = new Set([spec.id]);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const item of Object.values(replacement)) {
          if (!affected.has(item.spec.id) && item.spec.dependencies.some(dep => affected.has(dep))) { affected.add(item.spec.id); expanded = true; }
        }
      }
      for (const packageId of affected) requireThat(!['dispatching', 'executing'].includes(replacement[packageId].status), 'Settle affected Workers before revising contract');
      const packages = { ...replacement };
      for (const packageId of affected) {
        const item = packages[packageId];
        packages[packageId] = { ...item, status: item.runtimeRef ? 'stale' : 'specified', evidence: [] };
      }
      return { ...state, packages };
    }
    case 'package-dispatch-intended': {
      requireThat(state.status === 'ready' || state.status === 'executing', 'Approved Multi-WP Goal required');
      const data = event.data as { packageId?: string; key?: string };
      const packageState = data && state.packages?.[data.packageId ?? ''];
      requireThat(packageState?.status === 'specified' && data.key, 'Specified package and dispatch key required');
      return { ...state, packages: { ...state.packages, [data.packageId!]: { ...packageState, status: 'dispatching', dispatchIntent: data.key } } };
    }
    case 'package-started': {
      const data = event.data as { packageId?: string; ref?: unknown };
      const packageState = data && state.packages?.[data.packageId ?? ''];
      requireThat(packageState?.status === 'dispatching' && data.ref, 'Dispatch intent and runtime reference required');
      return { ...state, status: 'executing', packages: { ...state.packages, [data.packageId!]: { ...packageState, status: 'executing', runtimeRef: data.ref, dispatchIntent: undefined } } };
    }
    case 'package-resume-intended': {
      const data = event.data as { packageId?: string; key?: string };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(item?.status === 'stale' && item.runtimeRef && data.key, 'Stale package, owner and dispatch key required');
      requireThat(item.spec.dependencies.every(dep => state.packages?.[dep]?.status === 'verified'), 'Package dependencies must be verified');
      return { ...state, packages: { ...state.packages, [data.packageId!]: { ...item, status: 'resuming', dispatchIntent: data.key } } };
    }
    case 'package-resumed': {
      const data = event.data as { packageId?: string; ref?: unknown };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(item?.status === 'resuming' && data.ref, 'Resume intent and new runtime reference required');
      return { ...state, packages: { ...state.packages, [data.packageId!]: { ...item, status: 'executing', runtimeRef: data.ref, dispatchIntent: undefined } } };
    }
    case 'package-blocked': {
      const data = event.data as { packageId?: string; blocker?: PackageBlocker };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(item?.status === 'executing', 'Executing package required');
      requireThat(data.blocker && ['technical', 'product', 'external'].includes(data.blocker.kind) && typeof data.blocker.note === 'string' && data.blocker.note.trim(), 'Valid package blocker required');
      return { ...state, packages: { ...state.packages, [data.packageId!]: { ...item, status: 'blocked', blocker: data.blocker } } };
    }
    case 'package-unblocked': {
      const data = event.data as { packageId?: string; resolution?: string };
      const item = data && state.packages?.[data.packageId ?? ''];
      requireThat(item?.status === 'blocked' && item.blocker, 'Blocked package required');
      requireThat(item.blocker.kind !== 'product', 'Goal reapproval required for product blocker');
      requireThat(typeof data.resolution === 'string' && data.resolution.trim(), 'Blocker resolution required');
      return { ...state, packages: { ...state.packages, [data.packageId!]: { ...item, status: 'stale', blocker: undefined, evidence: [] } } };
    }
    case 'package-verified': {
      const data = event.data as { packageId?: string };
      const packageState = data && state.packages?.[data.packageId ?? ''];
      requireThat(packageState?.status === 'executing', 'Executing package required');
      const latest = new Map(packageState.evidence.map(item => [item.acceptanceId, item]));
      requireThat(packageState.spec.acceptance.every(item => latest.get(item.id)?.result === 'pass'), 'Passing package evidence required');
      return { ...state, packages: { ...state.packages, [data.packageId!]: { ...packageState, status: 'verified' } } };
    }
    case 'package-evidence-submitted': {
      const evidence = parsePackageEvidence(event.data);
      const packageState = state.packages?.[evidence.packageId];
      requireThat(packageState?.status === 'executing', 'Executing package required');
      requireThat(evidence.packageVersion === packageState.spec.version, 'Current package version required');
      requireThat(evidence.owner === packageState.spec.owner, 'Package owner mismatch');
      requireThat(packageState.spec.acceptance.some(item => item.id === evidence.acceptanceId), 'Unknown package acceptance ID');
      return { ...state, packages: { ...state.packages, [evidence.packageId]: { ...packageState, evidence: [...packageState.evidence, evidence] } } };
    }
    case 'execution-started':
      requireThat(state.status === 'ready' && state.selected && state.proposal && state.proposalApprovedVersion === state.proposal.version, 'Approved current proposal required');
      return { ...state, status: 'executing', runtimeRef: event.data, dispatchIntent: undefined };
    case 'dispatch-intended':
      requireThat(state.status === 'ready' && !state.dispatchIntent && state.selected && state.proposalApprovedVersion === state.proposal?.version, 'Approved current proposal required');
      requireThat(typeof event.data === 'string' && event.data.length > 0, 'Dispatch key required');
      return { ...state, dispatchIntent: event.data };
    case 'runtime-resumed':
      requireThat(state.status === 'executing' && state.runtimeRef, 'Existing execution required');
      return { ...state, runtimeRef: event.data };
    case 'checkpointed':
      requireThat(state.status === 'executing', 'Execution required');
      return { ...state, checkpoint: event.data };
    case 'blocked':
      requireThat(state.status === 'executing', 'Execution required');
      requireThat(event.data && typeof event.data === 'object', 'Blocker details required');
      return { ...state, status: 'blocked', blocker: event.data };
    case 'unblocked':
      requireThat(state.status === 'blocked', 'Blocked Goal required');
      return { ...state, status: 'executing', blocker: undefined };
    case 'decision-logged':
      requireThat(event.data && typeof event.data === 'object', 'Decision details required');
      return state;
    case 'evidence-submitted':
      requireThat(state.status === 'executing', 'Execution required');
      return { ...state, evidence: [...state.evidence, event.data] };
    case 'verified':
      requireThat(state.status === 'executing', 'Execution required');
      return { ...state, status: 'verified' };
    case 'outcome-accepted':
      requireThat(state.status === 'verified', 'Technical verification required');
      return { ...state, status: 'closed' };
    case 'outcome-revised':
      requireThat(state.status === 'verified', 'Technical verification required');
      return { ...state, status: 'draft', selected: false, proposalApprovedVersion: undefined };
    case 'outcome-stopped':
      return { ...state, status: 'stopped' };
  }
}
