import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertGoalExclusionComplete, parseGoalSpec } from '../domain/contracts.js';
import { sourceDigest } from '../domain/gate.js';
import type { Role } from '../domain/runtime-refs.js';
import type { PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';
import { KNOWN_AGENTS, ROLES, loadProfiles, setProfile } from '../runtime/brief.js';
import { OrcaRuntime } from '../runtime/orca/adapter.js';
import { worktreePath } from '../runtime/orca/parse.js';
import { controllerHome } from '../store/event-log.js';
import { liveController } from '../store/lease.js';
import { requestFromController } from '../app/controller-requests.js';
import type { ControllerRequest } from '../domain/controller-requests.js';
import { ProjectJournal } from '../store/journal.js';
import { newEvent } from '../app/events.js';
import { assertLeadTerminal } from '../app/lead.js';
import { recordBotCheckIn } from '../app/bot-wake-check.js';
import { UserError } from '../domain/errors.js';
import type { LeadState } from '../domain/transitions.js';
import type { CliOptions } from './options.js';

export type CliContext = {
  program: Command;
  options: CliOptions;
  write(line: string): void;
  writeError(line: string): void;
  runtime: RuntimeAdapter & Partial<PackageRuntime>;
  packageRuntime(): PackageRuntime;
  repo(): string;
  home(): string;
  withJournal<T>(fn: (journal: ProjectJournal) => T): T;
  withJournalAsync<T>(fn: (journal: ProjectJournal) => Promise<T>): Promise<T>;
  assertHuman(journal: ProjectJournal, command: string): void;
  /** The Goal's Lead only: the terminal or worktree APOS dispatched it, or the chat of the bot it moved to. */
  assertLead(journal: ProjectJournal, goalId: string, command: string): LeadState;
  /** After a Lead check passed for the bot holding the Lead: it acks the wakes before it and names its chat's mailbox. */
  checkInBot(journal: ProjectJournal, goalId: string, command: string): ReturnType<typeof recordBotCheckIn> | undefined;
  /** Set when a bot, a worker or another agent runs this command: it must not start workers or bind a Run. */
  callerAgent(journal: ProjectJournal): string | undefined;
  /** Queues a command that starts or moves an agent for the controller, and says so (warning when no watch runs). */
  requestDispatch(journal: ProjectJournal, goalId: string, request: ControllerRequest): void;
  /** Says the controller acts at its next tick, warning when no `apos controller watch` runs for this project. */
  awaitController(what: string): void;
  goalWithSource(file: string, sourcePath: string, origin: string): ReturnType<typeof goalWithSource>;
  readJsonFile(file: string): unknown;
  rolesOf(value: string): Role[];
  applyProfile(roles: Role[], change: { agent: string; model?: string; effort?: string }): void;
};

/** PowerShell's `Set-Content -Encoding utf8` writes a BOM, which JSON.parse rejects. */
function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** Reads the Goal JSON and the verbatim source; fills `source` when absent, otherwise checks it matches. */
function goalWithSource(file: string, sourcePath: string, origin: string) {
  const raw = readJsonFile(file) as Record<string, unknown>;
  const text = readFileSync(sourcePath, 'utf8');
  const digest = sourceDigest(text);
  const given = raw.source as { sha256?: string } | undefined;
  if (given?.sha256 && given.sha256 !== digest)
    throw new Error(
      `Goal source sha256 does not match --source file: expected ${digest} (APOS hashes the text with CRLF line endings turned into LF, so a hash of the raw file on Windows differs); or omit "source" from goal.json and APOS fills it in.`,
    );
  const spec = parseGoalSpec({
    ...raw,
    source: given ?? { path: sourcePath, sha256: digest, capturedAt: new Date().toISOString(), origin },
  });
  assertGoalExclusionComplete(spec);
  return { spec, text };
}

export function createContext(program: Command, options: CliOptions): CliContext {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  const repo = () => resolve(program.opts<{ repo: string }>().repo);
  // Role profiles come from <controller home>/runtime.json, read when a dispatch needs them.
  const runtime =
    options.runtime ??
    new OrcaRuntime(
      undefined,
      undefined,
      () => loadProfiles(options.home ?? controllerHome(repo())),
      undefined,
      () => join(options.home ?? controllerHome(repo()), 'notes'),
    );
  const packageRuntime = (): PackageRuntime => {
    if (!runtime.startPackage) throw new Error('Configured runtime cannot start Work Package Workers');
    return runtime as PackageRuntime;
  };
  const openJournal = () => {
    const path = repo();
    if (!existsSync(join(path, '.apos', 'project.yaml'))) throw new Error('Run apos init first');
    return ProjectJournal.open(path, options.home, newEvent);
  };
  const withJournal = <T>(fn: (journal: ProjectJournal) => T): T => {
    const { journal, close } = openJournal();
    try {
      return fn(journal);
    } finally {
      close();
    }
  };
  const withJournalAsync = async <T>(fn: (journal: ProjectJournal) => Promise<T>): Promise<T> => {
    const { journal, close } = openJournal();
    try {
      return await fn(journal);
    } finally {
      close();
    }
  };
  /** The terminal or worktree APOS dispatched an agent to that this process runs in, from the Goals' state and start events. */
  const agentPlace = (journal: ProjectJournal): string | undefined => {
    const terminals = new Set<string>();
    const worktrees = new Set<string>();
    const add = (ref: unknown) => {
      const item = ref as { terminal?: string; worktreeId?: string } | undefined;
      if (item?.terminal) terminals.add(item.terminal);
      const path = worktreePath(item?.worktreeId);
      if (path) worktrees.add(resolve(path).toLowerCase());
    };
    for (const state of journal.listGoals()) {
      add(state.runtimeRef);
      add(state.reviewDispatch);
      for (const item of Object.values(state.packages ?? {})) add(item.runtimeRef);
      if (state.leadTerminal) terminals.add(state.leadTerminal.terminal);
      if (state.lead) add(state.lead.ref);
      // The Lead is an agent from the moment APOS dispatches it, long before it commits a plan.
      for (const item of journal.events(state.spec.id))
        if (
          [
            'lead-started',
            'execution-started',
            'runtime-resumed',
            'package-started',
            'package-resumed',
            'owner-handed-off',
          ].includes(item.type)
        )
          add((item.data as { ref?: unknown })?.ref ?? item.data);
    }
    const here = resolve(process.cwd()).toLowerCase();
    const handle = process.env.ORCA_TERMINAL_HANDLE;
    if (handle && terminals.has(handle)) return `APOS agent terminal ${handle}`;
    const tree = [...worktrees].find(
      path => here === path || here.startsWith(`${path}\\`) || here.startsWith(`${path}/`),
    );
    return tree ? `APOS agent worktree ${tree}` : undefined;
  };
  /**
   * Why this process is an agent rather than the controller or the Human: a bot's chat, an Orca agent session (Orca
   * sets ORCA_AGENT_SESSION_ID in every agent chat, bot or worker), or a terminal or worktree APOS dispatched. Only the
   * controller starts workers and coordinates the Runs, so an agent's command records its decision and the controller
   * acts on it at its next tick.
   */
  const callerAgent = (journal: ProjectJournal): string | undefined => {
    let bot: ReturnType<NonNullable<typeof runtime.callerBot>>;
    try {
      bot = runtime.callerBot?.();
    } catch {
      bot = undefined;
    }
    if (bot) return `bot ${bot.name}`;
    const session = process.env.ORCA_AGENT_SESSION_ID?.trim();
    if (session) return `Orca agent session ${session}`;
    return agentPlace(journal);
  };
  /**
   * Gates A, B and D, appetite changes and overrides belong to the Human. Owners run with a shell and
   * know this CLI, so these commands refuse to run from any agent terminal or worktree APOS dispatched.
   */
  const assertHuman = (journal: ProjectJournal, command: string) => {
    if (agentPlace(journal))
      throw new Error(`${command} is a Human decision and cannot run from an APOS agent terminal or worktree`);
    // A bot holding a Lead is an agent too, wherever it runs: its session is told apart through Orca, not its cwd.
    const leadBots = new Map(
      journal
        .listGoals()
        .filter(state => state.leadBot)
        .map(state => [state.leadBot!.id, state.spec.id] as const),
    );
    if (!leadBots.size || !runtime.callerBot) return;
    let bot: ReturnType<NonNullable<typeof runtime.callerBot>>;
    try {
      bot = runtime.callerBot();
    } catch (error) {
      throw new UserError(
        `${command} is a Human decision, a bot holds a Lead here, and Orca could not say whether this session is that bot (${error instanceof Error ? error.message : String(error)}); run it from your own terminal`,
      );
    }
    if (bot && leadBots.has(bot.id))
      throw new UserError(
        `${command} is a Human decision and cannot run from bot ${bot.name}, which holds the Lead of ${leadBots.get(bot.id)}`,
      );
  };
  const assertLead = (journal: ProjectJournal, goalId: string, command: string): LeadState => {
    const state = journal.getGoal(goalId);
    if (!state) throw new UserError(`Goal not found: ${goalId}`);
    const handle = process.env.ORCA_TERMINAL_HANDLE;
    const foreignTerminal =
      handle &&
      handle !== state.lead?.ref.terminal &&
      journal.listGoals().some(
        goal =>
          goal.lead?.ref.terminal === handle ||
          goal.reviewDispatch?.terminal === handle ||
          Object.values(goal.packages ?? {}).some(item => item.runtimeRef?.terminal === handle) ||
          journal.events(goal.spec.id).some(event => {
            if (
              !['lead-started', 'package-started', 'package-resumed', 'owner-handed-off', 'review-dispatched'].includes(
                event.type,
              )
            )
              return false;
            const data = event.data as { terminal?: string; ref?: { terminal?: string } };
            return (data.ref?.terminal ?? data.terminal) === handle;
          }),
      );
    if (foreignTerminal) throw new UserError(`${command} is Lead only`);
    const lead = assertLeadTerminal(state, handle, command, process.cwd(), () => runtime.callerBot?.());
    checkInBot(journal, goalId, command);
    return lead;
  };
  /**
   * Only after `assertLeadTerminal` passed: with a bot holding the Lead, this process is that bot's chat. Orca not
   * naming the chat's mailbox never blocks the command; the ack still counts and check D keeps the last mailbox.
   */
  const checkInBot = (journal: ProjectJournal, goalId: string, command: string) => {
    const bot = journal.getGoal(goalId)?.leadBot;
    if (!bot) return undefined;
    let mailbox: string | undefined;
    try {
      mailbox = runtime.callerMailbox?.();
    } catch {
      mailbox = undefined;
    }
    return recordBotCheckIn(journal, goalId, bot.id, mailbox, command);
  };
  const home = () => options.home ?? controllerHome(repo());
  const awaitController = (what: string) => {
    write(what);
    if (!liveController(home()))
      write(
        `warning: no \`apos controller watch\` is running for this project, so nothing happens until one does. Start it in a plain Orca terminal (not an agent chat): apos --repo ${repo()} controller watch`,
      );
  };
  const requestDispatch = (journal: ProjectJournal, goalId: string, request: ControllerRequest) =>
    awaitController(requestFromController(journal, goalId, request));
  /** `all` or one role, as the profile and handoff commands take it. */
  const rolesOf = (value: string): Role[] => {
    if (value === 'all') return ROLES;
    if (!(ROLES as string[]).includes(value))
      throw new Error(`Unknown role ${value}: use lead, worker, reviewer or all`);
    return [value as Role];
  };
  /** Writes a role profile for the Human, warning about an agent APOS has no screen rules for. */
  const applyProfile = (roles: Role[], change: { agent: string; model?: string; effort?: string }) => {
    if (change.model !== undefined && (!change.model.trim() || /\s/.test(change.model) || change.model.startsWith('-')))
      throw new Error(
        `--model "${change.model}" is not a model id (no spaces, not starting with a dash); check the exact id in the agent's own model list`,
      );
    setProfile(home(), roles, change);
    if (!(KNOWN_AGENTS as readonly string[]).includes(change.agent))
      write(
        `warning: ${change.agent} is not a known agent (${KNOWN_AGENTS.join(', ')}); Orca must accept it, and its screen is read with every rule set`,
      );
  };
  return {
    program,
    options,
    write,
    writeError,
    runtime,
    packageRuntime,
    repo,
    home,
    withJournal,
    withJournalAsync,
    assertHuman,
    assertLead,
    checkInBot,
    callerAgent,
    requestDispatch,
    awaitController,
    goalWithSource,
    readJsonFile,
    rolesOf,
    applyProfile,
  };
}
