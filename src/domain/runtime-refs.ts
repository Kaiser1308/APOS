export type Role = 'lead' | 'worker' | 'reviewer';
/** Which agent, model and effort each role runs with. Owners default to Codex terra, the measured configuration. */
export type RuntimeProfile = { agent: string; model?: string; effort?: string };
export type RuntimeProfiles = Record<Role, RuntimeProfile>;
/** What a fresh agent takes over: the Lead before or after its plan, the Solo owner, or a package Worker. */
export type HandoffKind = 'lead-plan' | 'solo-owner' | 'lead-multi' | 'worker';
/** What the Human's appetite leaves for the owner. Seen live: an owner that did not know it stopped at 15 of 90 minutes. */
export type Budget = { minutesLeft: number; attemptsLeft: number };

export type RuntimeRef = {
  runId: string;
  taskId: string;
  dispatchId: string;
  owner: 'lead';
  repoPath: string;
  terminal?: string;
  worktreeId?: string;
  baseCommit?: string;
  requested?: RuntimeProfile;
};
/** What Orca says actually launched; compared with the requested profile. */
export type LaunchReceipt = { agent?: string; model?: string | null; effort?: string | null };
export type ReviewerRef = {
  runId: string;
  taskId: string;
  dispatchId: string;
  owner: 'reviewer';
  repoPath: string;
  terminal?: string;
  worktreeId?: string;
  key: string;
  commit: string;
  requested?: RuntimeProfile;
};
export type PackageRuntimeRef = {
  runId: string;
  taskId: string;
  dispatchId: string;
  owner: 'worker';
  repoPath: string;
  terminal?: string;
  worktreeId?: string;
  baseCommit?: string;
  requested?: RuntimeProfile;
};
