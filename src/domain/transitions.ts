import { parseExecutionProposal, parseGoalSpec, type ExecutionProposal, type GoalSpec } from './contracts.js';

export type GoalEventType =
  | 'goal-drafted' | 'goal-approved' | 'goal-selected' | 'goal-revised'
  | 'proposal-drafted' | 'proposal-approved' | 'proposal-revised'
  | 'dispatch-intended' | 'execution-started' | 'runtime-resumed' | 'checkpointed' | 'blocked' | 'unblocked' | 'decision-logged' | 'evidence-submitted'
  | 'verified' | 'outcome-accepted' | 'outcome-revised' | 'outcome-stopped';
export type GoalEvent = { id: string; goalId: string; type: GoalEventType; data?: unknown; at: string };
export type GoalStatus = 'draft' | 'approved' | 'selected' | 'planned' | 'ready' | 'executing' | 'blocked' | 'verified' | 'closed' | 'stopped';
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
    return { spec, status: 'draft', selected: false, evidence: [] };
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
      return { spec, status: 'draft', selected: false, evidence: [] };
    }
    case 'proposal-drafted':
    case 'proposal-revised': {
      requireThat(state.selected && state.approvedGoalVersion === state.spec.version, 'Select approved Goal first');
      const proposal = parseExecutionProposal(event.data);
      requireThat(proposal.goalId === state.spec.id && proposal.goalVersion === state.spec.version, 'Proposal Goal version mismatch');
      requireThat(!state.proposal || proposal.version > state.proposal.version, 'Proposal version must advance');
      return { ...state, proposal, proposalApprovedVersion: undefined, status: 'planned', evidence: [] };
    }
    case 'proposal-approved':
      requireThat(state.proposal && state.selected && state.proposal.goalVersion === state.spec.version, 'Current proposal required');
      return { ...state, proposalApprovedVersion: state.proposal.version, status: 'ready' };
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
