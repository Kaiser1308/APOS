import type { PhaseCheckpoint } from '../domain/contracts.js';
import type { WorkPackageSpec } from '../domain/packages.js';
import type {
  Budget,
  HandoffKind,
  LaunchReceipt,
  PackageRuntimeRef,
  ReviewerRef,
  Role,
  RuntimeProfile,
  RuntimeRef,
} from '../domain/runtime-refs.js';

/** `idleMinutes`: how long Orca says the agent has been idle (worker-show `activity` + `lastActivity`), when it says. */
export type RuntimeObservation = {
  state: 'live' | 'settled' | 'unverifiable';
  outcome?: 'completed' | 'failed';
  idleMinutes?: number;
  ref: RuntimeRef;
};
export type OrcaMessage = {
  id: string;
  type: string;
  subject?: string;
  body?: string;
  payload?: unknown;
  dispatch_id?: string;
  dispatchId?: string;
  /** The sender's Orca handle (a worker's terminal or chat). */
  from?: string;
};
/** An Orca bot on this computer (`orca bot list`); one can hold a Multi-WP Lead role. */
export type BotIdentity = { id: string; name: string; paused?: boolean };
/** A mail to the bot holding a Goal's Lead: `mode` says which phase the Goal is in. */
export type BotWakeInput = {
  repoPath: string;
  goalId: string;
  bot: BotIdentity;
  events: string[];
  mode: 'plan' | 'solo' | 'multi';
  leadWorktree?: string;
};
export type OrcaDelivery = { deliveryId?: string; messages: OrcaMessage[] };
/** The Lead the controller dispatches when the Human selects a Goal; in Solo it is also the owner. */
export type HandoffInput = {
  kind: HandoffKind;
  role: Role;
  repoPath: string;
  goalId: string;
  goalVersion?: number;
  runId: string;
  worktreeId: string;
  baseCommit: string;
  idempotencyKey: string;
  attempt: number;
  fromAgent?: string;
  packageId?: string;
  packageVersion?: number;
  owner?: string;
  outcome?: string;
  packageContract?: WorkPackageSpec;
  extra?: string;
  budget?: Budget;
};
export type WakeInput = {
  repoPath: string;
  goalId: string;
  terminal: string;
  worktree: string;
  runId: string;
  events: string[];
  idempotencyKey: string;
  phase?: 'plan' | 'multi';
  requested?: { agent?: string; model?: string };
  baseCommit?: string;
  goalVersion?: number;
};
export type LeadInput = {
  repoPath: string;
  goalId: string;
  goalVersion: number;
  idempotencyKey: string;
  budget?: Budget;
};
export interface RuntimeAdapter {
  startLead(input: LeadInput): Promise<RuntimeRef>;
  resumeSolo(
    ref: RuntimeRef,
    checkpoint: PhaseCheckpoint,
    idempotencyKey: string,
    budget?: Budget,
  ): Promise<RuntimeRef>;
  /** The terminal Orca has as the Run's coordinator (`run-show --full`); null when no terminal is bound. */
  runCoordinator?(runId: string): Promise<string | null>;
  /** Replies to an owner's message on its Run. */
  replyMessage?(runId: string, messageId: string, body: string): Promise<void>;
  inspect(ref: RuntimeRef): Promise<RuntimeObservation>;
  recover?(key: string, runId?: string): Promise<RuntimeRef | undefined>;
  /** The Run's unread mail, read without consuming it: mail left pending comes back on the next read. */
  checkRun?(runId: string): Promise<OrcaDelivery>;
  /** Consumes the Run's unread mail once `handled` (message ids) is done; returns mail that arrived after the read. */
  ackRun?(runId: string, handled: string[]): Promise<OrcaMessage[]>;
  retainWorker?(dispatchId: string): Promise<void>;
  releaseWorker?(dispatchId: string): Promise<void>;
  /** Head commit of the owner's worktree: the delivery the controller gates. */
  deliveryHead?(ref: { worktreeId?: string; dispatchId?: string }): Promise<string | undefined>;
  launchReceipt?(dispatchId: string): Promise<LaunchReceipt | undefined>;
  /** True when Orca accepted the input but the agent never started (no heartbeat, still at input_accepted). */
  inputStalled?(dispatchId: string): Promise<boolean>;
  /**
   * Reads the agent terminal: true when a brief sits unsubmitted in the composer and the agent is not
   * working. Orca's own stage was wrong both ways in the SQLFMT pilot, so the screen is the evidence.
   */
  composerPending?(terminal: string, agent?: string): Promise<boolean>;
  /** The agent's own out-of-quota line on its screen, read with that agent's rules (`screens.ts`). */
  agentQuota?(terminal: string, agent?: string, dispatchId?: string): Promise<string | undefined>;
  /** Presses Enter once in the owner's terminal. */
  nudge?(terminal: string): Promise<void>;
  startReviewer?(input: {
    repoPath: string;
    goalId: string;
    baseCommit: string;
    commit: string;
    reasons: string[];
    idempotencyKey: string;
    runId: string;
  }): Promise<ReviewerRef>;
  /** Fences a dispatch and closes its agent; 'unknown' when Orca cannot confirm the agent stopped. */
  stopWorker?(dispatchId: string): Promise<'stopped' | 'unknown'>;
  /** A fresh agent with the role's current profile on an existing worktree and Run (`handoffBrief`). */
  handoff?(input: HandoffInput): Promise<RuntimeRef>;
  /** With `requested` and `baseCommit`, a changed lead profile wakes a fresh agent on the Lead worktree and returns its terminal. */
  wakeLead?(input: WakeInput): Promise<{ dispatchId: string; terminal?: string; requested?: RuntimeProfile }>;
  /** A bot on this computer by id or name. */
  findBot?(nameOrId: string): BotIdentity | undefined;
  /** The bot whose chat runs this process; undefined outside a bot chat; throws when Orca cannot tell. */
  callerBot?(): BotIdentity | undefined;
  /** Mails the bot holding a Lead its events (`orca orchestration send --to bot:<id> --type handoff`). */
  wakeBot?(input: BotWakeInput): Promise<{ messageId?: string }>;
  /** Information for a bot with nothing to do (`--type status`), such as its Lead role ending. */
  tellBot?(bot: BotIdentity, subject: string, body: string): Promise<void>;
}
export interface PackageRuntime {
  /** `dependencyCommits`: the verified commits of the package's dependencies; its worktree must start from them. */
  startPackage(input: {
    package: WorkPackageSpec;
    repoPath: string;
    idempotencyKey: string;
    dependencyCommits?: string[];
  }): Promise<PackageRuntimeRef>;
  inspectPackage?(ref: PackageRuntimeRef): Promise<'completed' | 'failed' | 'live' | 'unverifiable'>;
  resumePackage?(input: {
    package: WorkPackageSpec;
    prior: PackageRuntimeRef;
    idempotencyKey: string;
    finding?: string;
    attempt?: number;
    dependencyCommits?: string[];
  }): Promise<PackageRuntimeRef>;
  recoverPackage?(key: string, runId?: string): Promise<PackageRuntimeRef | undefined>;
}
