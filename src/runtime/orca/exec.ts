import { execFileSync } from 'node:child_process';
import type { RuntimeProfile, RuntimeRef, Role } from '../../domain/runtime-refs.js';
import type { HandoffInput } from '../../ports/runtime.js';
import { id, object, parseOrcaResult } from './parse.js';

/** Orca answered with an explicit error: the mutation did not happen, so retrying cannot duplicate it. */
export class OrcaRefused extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'OrcaRefused';
  }
}

/** Orca refused because the session that owned the call has ended (its chat was closed); the call will never work, so the next step is a fresh agent. */
export const isDeadSession = (error: unknown): boolean =>
  error instanceof OrcaRefused
    ? error.code === 'session_caller_not_live'
    : /\[session_caller_not_live\]/.test(error instanceof Error ? error.message : String(error));

/**
 * Orca 1.4.265 answers with a concise view by default. APOS reads the full record of `worker-show`, of `run-show`
 * (only the full record names the Run's coordinator), and of `task-list`, whose concise rows drop the `spec` recovery
 * finds a dispatch key in. `worker-start` stays concise:
 * its receipt carries runId, taskId, dispatchId, terminal and workspace, and only the concise view exits 0 for a
 * start whose turn Orca has not observed yet (`--full` exits 1 for anything but ready).
 */
const fullFlag = (args: string[]): string[] =>
  args[0] === 'orchestration' &&
  ['worker-show', 'task-list', 'run-show'].includes(args[1] ?? '') &&
  !args.includes('--full')
    ? ['--full']
    : [];

/** A worker-start that exited 1 only because Orca has not observed its turn yet: the worker did start. */
const startedUnobserved = (args: string[], result: Record<string, unknown> | undefined): boolean =>
  args[0] === 'orchestration' &&
  args[1] === 'worker-start' &&
  typeof result?.dispatchId === 'string' &&
  (result.stage === 'turn_start_unobserved' || result.state === 'turn_start_unobserved');

/** `--compact` is APOS-internal: ask for Orca's concise view (the only one that carries `activity` and `lastActivity`) instead of the full record. */
export const COMPACT = '--compact';

export const SPILL_LIMIT = 400;

/** The argv `runOrca` hands to the orca CLI for an APOS call. */
export function orcaArgs(argv: string[]): string[] {
  const args = argv.filter(item => item !== COMPACT);
  return [...args, ...(argv.includes(COMPACT) ? [] : fullFlag(args)), '--json'];
}

export function runOrca(argv: string[]): Record<string, unknown> {
  const args = argv.filter(item => item !== COMPACT);
  try {
    return parseOrcaResult(
      execFileSync('orca', orcaArgs(argv), {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    let detail = '';
    try {
      const parsed = stdout
        ? (JSON.parse(stdout) as {
            error?: { code?: string; message?: string };
            result?: Record<string, unknown> & { state?: string; stage?: string; failedStage?: string };
          })
        : undefined;
      if (parsed?.result && startedUnobserved(args, parsed.result)) return parsed.result;
      if (parsed?.error) detail = ` [${parsed.error.code}] ${parsed.error.message}`;
      else if (parsed?.result)
        detail = ` state=${parsed.result.state} stage=${parsed.result.stage ?? ''} failedStage=${parsed.result.failedStage ?? ''}`;
    } catch {
      detail = stdout ? ` ${stdout.slice(0, 500)}` : '';
    }
    const code = /^ \[([a-z_]+)\]/.exec(detail)?.[1];
    const message = `Orca ${args[0]} ${args[1] ?? ''} failed:${detail || ` ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`}`;
    throw code ? new OrcaRefused(message, code) : new Error(message);
  }
}

/** The worktree a terminal lives in, so a Lead wake targets the Lead's own worktree even when it passed only `--terminal`. */
export function terminalWorktree(
  handle: string,
  execute: (args: string[]) => Record<string, unknown> = runOrca,
): string {
  const worktreeId = object(object(execute(['terminal', 'show', '--terminal', handle])).terminal).worktreeId;
  return `id:${id(worktreeId, 'terminal worktree')}`;
}

// Codex can take over a minute to become ready; Orca's 60 s default reported a dispatch that did start as failed (seen live).
export const launchArgs = (profile: RuntimeProfile): string[] => [
  '--timeout-ms',
  '240000',
  '--agent',
  profile.agent,
  ...(profile.model ? ['--model', profile.model] : []),
  ...(profile.model && profile.effort ? ['--effort', profile.effort] : []),
];

/** Pages through `orchestration run-list` until Orca stops giving a cursor. */
export function listRuns(execute: (args: string[]) => Record<string, unknown>): Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const args = ['orchestration', 'run-list'];
    if (cursor) args.push('--cursor', cursor);
    const page = execute(args);
    runs.push(...(Array.isArray(page.runs) ? page.runs : []).map(object));
    cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
    if (cursor && seen.has(cursor)) throw new Error('Orca Run pagination repeated its cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return runs;
}

/** What the extracted package and handoff modules use from an `OrcaRuntime`; the adapter builds it from its own state. */
export interface OrcaContext {
  execute(args: string[]): Record<string, unknown>;
  gitHead(repoPath: string): string;
  fileDigest(repoPath: string, commit: string, path: string): string;
  profile(role: Role): RuntimeProfile;
  spill(text: string, key: string): string;
  /** Per `OrcaRuntime` instance: one Run per package objective. */
  readonly packageRuns: Map<string, Promise<string>>;
  handoff(input: HandoffInput): Promise<RuntimeRef>;
  recover(key: string, knownRunId?: string): Promise<RuntimeRef | undefined>;
}
