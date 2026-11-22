import type { ExecutionProposal } from '../domain/contracts.js';
import type { GoalEvent, GoalState } from '../domain/transitions.js';
import type { ReadOnlyJournal } from '../store/readonly-journal.js';

/** One thing an owner or the Lead put on record. Only structured sources: nothing here is inferred from prose. */
export type StoryEntry = {
  at: string;
  type: string;
  kind: 'decision' | 'report' | 'blocker' | 'finding' | 'review';
  text: string;
  by?: string;
};
export type StoryOwner = {
  id: string;
  label: string;
  status?: string;
  attempts: number;
  outcome?: string;
  dependencies: string[];
  entries: StoryEntry[];
};
export type Story = {
  goal: {
    outcome: string;
    scope: string[];
    exclusions: string[];
    requirements: { id: string; text: string; disposition: string; exclusionReason?: string }[];
    acceptance: { id: string; text: string; requirementIds: string[] }[];
    appetite?: GoalState['appetite'];
  };
  lead?: {
    mode: ExecutionProposal['mode'];
    modeLabel: string;
    approved: boolean;
    approach: string;
    whySplit: string;
    risks: string[];
    sharedPaths: string[];
    acceptanceMapping: { acceptanceId: string; verification: string }[];
    verificationStrategy: string;
    estimatedCost?: ExecutionProposal['estimatedCost'];
  };
  owners: StoryOwner[];
};

const MODE_LABEL: Record<ExecutionProposal['mode'], string> = {
  'solo-direct': 'Tự làm một mạch (1 owner)',
  'solo-phased': 'Tự làm theo giai đoạn (1 owner)',
  'multi-wp': 'Chia nhiều Work Package',
};

type Data = Record<string, unknown>;
const obj = (value: unknown): Data => (value && typeof value === 'object' ? (value as Data) : {});
const str = (value: unknown): string =>
  typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);

/** Turns one recorded event into a readable entry and says whose it is; undefined when the event is not part of the story. */
function entryOf(event: GoalEvent): { owner: string; entry: StoryEntry } | undefined {
  const data = obj(event.data);
  const owner = typeof data.packageId === 'string' ? data.packageId : 'goal';
  const base = { at: event.at, type: event.type };
  switch (event.type) {
    case 'package-submitted':
      return {
        owner,
        entry: {
          ...base,
          kind: 'report',
          by: str(data.by),
          text: `submitted ${str(data.commit).slice(0, 7)} for its gate`,
        },
      };
    case 'package-gate-recorded': {
      const report = obj(data.report);
      return {
        owner,
        entry: {
          ...base,
          kind: 'report',
          text: `gate ${str(report.result)} on ${str(report.deliveryCommit).slice(0, 7)}`,
        },
      };
    }
    case 'decision-logged':
      return { owner, entry: { ...base, kind: 'decision', text: str(data.note) } };
    case 'checkpointed':
      return { owner, entry: { ...base, kind: 'report', text: `${str(data.phase)}: ${str(data.progress)}` } };
    case 'owner-progress-observed': {
      const commits = Array.isArray(data.commits) ? (data.commits as Record<string, unknown>[]) : [];
      const latest = (data.latest as Record<string, unknown> | undefined) ?? commits.at(-1);
      const total = typeof data.commitCount === 'number' ? data.commitCount : commits.length;
      const text = latest
        ? `worktree: ${total} commit(s), latest ${str(latest.hash).slice(0, 7)} "${str(latest.subject)}" (${str(latest.filesChanged)} file(s))${data.dirty ? ` + ${str(data.dirtyFiles)} uncommitted` : ''}`
        : `worktree: ${str(data.dirtyFiles)} uncommitted file(s)`;
      return { owner, entry: { ...base, kind: 'report', text } };
    }
    case 'evidence-submitted':
    case 'package-evidence-submitted':
      return {
        owner,
        entry: { ...base, kind: 'report', text: `${str(data.acceptanceId)} ${str(data.result)}: ${str(data.command)}` },
      };
    case 'blocked':
    case 'package-blocked': {
      const blocker = obj(data.blocker ?? data);
      return { owner, entry: { ...base, kind: 'blocker', text: `${str(blocker.kind)}: ${str(blocker.note)}` } };
    }
    case 'unblocked':
    case 'package-unblocked':
      return {
        owner,
        entry: {
          ...base,
          kind: 'decision',
          text: data.resolution ? `unblocked: ${str(data.resolution)}` : 'unblocked',
        },
      };
    case 'finding-recorded':
      return {
        owner,
        entry: { ...base, kind: 'finding', text: `${str(data.kind)}: ${str(data.note)}`, by: str(data.by) },
      };
    case 'review-submitted':
      return {
        owner,
        entry: { ...base, kind: 'review', text: `${str(data.result)}: ${str(data.note)}`, by: str(data.reviewer) },
      };
    default:
      return undefined;
  }
}

export function buildStory(repo: ReadOnlyJournal, id: string): Story | undefined {
  const state = repo.getGoal(id);
  if (!state) return undefined;
  const proposal = state.proposal;
  const owners = new Map<string, StoryOwner>();
  // A Solo plan's implicit WP-MAIN is the Goal itself: its entries stay under the Goal.
  const multi = proposal?.mode === 'multi-wp';
  owners.set('goal', {
    id: 'goal',
    label: multi ? 'Goal (Lead / chung)' : 'Goal (Solo)',
    status: state.status,
    attempts: 0,
    dependencies: [],
    entries: [],
  });
  for (const item of multi ? Object.values(state.packages ?? {}) : []) {
    owners.set(item.spec.id, {
      id: item.spec.id,
      label: item.spec.id,
      status: item.status,
      attempts: item.attempts,
      outcome: item.spec.outcome,
      dependencies: item.spec.dependencies,
      entries: [],
    });
  }
  for (const event of repo.events(id)) {
    const hit = entryOf(event);
    if (!hit) continue;
    const target = owners.get(hit.owner) ?? owners.get('goal')!;
    target.entries.push(hit.entry);
  }
  const ordered = [...owners.values()].filter(item => item.id !== 'goal' || item.entries.length || !multi);
  return {
    goal: {
      outcome: state.spec.outcome,
      scope: state.spec.scope,
      exclusions: state.spec.exclusions,
      requirements: state.spec.requirements.map(item => ({
        id: item.id,
        text: item.text,
        disposition: item.disposition,
        exclusionReason: item.exclusionReason,
      })),
      acceptance: state.spec.acceptance.map(item => ({
        id: item.id,
        text: item.text,
        requirementIds: item.requirementIds,
      })),
      appetite: state.appetite,
    },
    lead: proposal && {
      mode: proposal.mode,
      modeLabel: MODE_LABEL[proposal.mode],
      approved: state.proposalApprovedVersion === proposal.version,
      approach: proposal.approach,
      whySplit:
        proposal.rationale ??
        proposal.splitRationale ??
        (proposal.mode === 'multi-wp'
          ? 'not recorded'
          : 'not recorded (Lead không ghi lý do chia: chọn làm với một owner)'),
      risks: proposal.risks,
      sharedPaths: proposal.sharedPaths,
      acceptanceMapping: proposal.acceptanceMapping.map(item => ({
        acceptanceId: item.acceptanceId,
        verification: item.verification,
      })),
      verificationStrategy: proposal.verificationStrategy,
      estimatedCost: proposal.estimatedCost,
    },
    owners: ordered,
  };
}
