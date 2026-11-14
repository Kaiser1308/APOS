import { Command } from 'commander';

/** PowerShell's `Set-Content -Encoding utf8` writes a BOM, which JSON.parse rejects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJsonFile(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}
import { withControllerLease } from './store/lease.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAppetite, parseExecutionProposal, parseGoalSpec, type Evidence, type PhaseCheckpoint } from './domain/contracts.js';
import type { GoalEventType } from './domain/transitions.js';
import { initProject } from './app/init-project.js';
import { SoloService } from './app/solo.js';
import { HandoffService } from './app/handoff.js';
import type { HandoffTarget } from './domain/transitions.js';
import { LeadService, assertLeadTerminal, currentLeadRef } from './app/lead.js';
import { PackageService, type PackageRuntime } from './app/packages.js';
import { IntegrationService, parseIntegrationInput, type CommitInspector } from './app/integration.js';
import { ControllerService } from './app/controller.js';
import { MergeService } from './app/merge.js';
import { ReviewService } from './app/review.js';
import { assertExecutionSettled } from './app/replan.js';
import { MetricsService } from './app/metrics.js';
import { buildInbox } from './app/inbox.js';
import { DEFAULT_UI_PORT, startUi } from './ui/server.js';
import { GoalRegistryService } from './app/registry.js';
import { VerificationService } from './app/verification.js';
import { GateService, type GateOptions } from './app/gate.js';
import { CodexSessionProbe, type TelemetryProbe } from './runtime/telemetry.js';
import { KNOWN_AGENTS, ROLES, describeProfiles, loadProfiles, resetProfile, setProfile, type Role } from './runtime/brief.js';
import { controllerHome } from './store/event-log.js';
import { sourceDigest } from './domain/gate.js';
import { assertMultiWpPlannable, parseWorkPackage } from './domain/packages.js';
import { OrcaRuntime, worktreePath, type RuntimeAdapter } from './runtime/orca.js';
import { ProjectJournal } from './store/journal.js';

export type CliOptions = { runtime?: RuntimeAdapter & Partial<PackageRuntime>; inspector?: CommitInspector; gate?: GateOptions; telemetry?: TelemetryProbe; home?: string; write?: (line: string) => void };

export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const program = new Command();
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  // Role profiles come from <controller home>/runtime.json, read when a dispatch needs them.
  const runtime = options.runtime ?? new OrcaRuntime(undefined, undefined, () => loadProfiles(options.home ?? controllerHome(repo())), undefined, () => join(options.home ?? controllerHome(repo()), 'notes'));
  const packageRuntime = (): PackageRuntime => {
    if (!runtime.startPackage) throw new Error('Configured runtime cannot start Work Package Workers');
    return runtime as PackageRuntime;
  };
  program.name('apos').description('Local AI Project Orchestration System').version('0.1.0').option('--repo <path>', 'managed Git project', process.cwd());

  const repo = () => resolve(program.opts<{ repo: string }>().repo);
  const openJournal = () => {
    const path = repo();
    if (!existsSync(join(path, '.apos', 'project.yaml'))) throw new Error('Run apos init first');
    return ProjectJournal.open(path, options.home);
  };
  const withJournal = <T>(fn: (journal: ProjectJournal) => T): T => {
    const { journal, close } = openJournal();
    try { return fn(journal); } finally { close(); }
  };
  const withJournalAsync = async <T>(fn: (journal: ProjectJournal) => Promise<T>): Promise<T> => {
    const { journal, close } = openJournal();
    try { return await fn(journal); } finally { close(); }
  };
  const event = (goalId: string, type: GoalEventType, data?: unknown) => ({ id: randomUUID(), goalId, type, data, at: new Date().toISOString() });
  /**
   * Gates A, B and D, appetite changes and overrides belong to the Human. Owners run with a shell and
   * know this CLI, so these commands refuse to run from any agent terminal or worktree APOS dispatched.
   */
  const assertHuman = (journal: ProjectJournal, command: string) => {
    const terminals = new Set<string>();
    const worktrees = new Set<string>();
    const add = (ref: unknown) => {
      const item = ref as { terminal?: string; worktreeId?: string } | undefined;
      if (item?.terminal) terminals.add(item.terminal);
      const path = worktreePath(item?.worktreeId);
      if (path) worktrees.add(resolve(path).toLowerCase());
    };
    for (const state of journal.listGoals()) {
      add(state.runtimeRef); add(state.reviewDispatch);
      for (const item of Object.values(state.packages ?? {})) add(item.runtimeRef);
      if (state.leadTerminal) terminals.add(state.leadTerminal.terminal);
      if (state.lead) add(state.lead.ref);
      // The Lead is an agent from the moment APOS dispatches it, long before it commits a plan.
      for (const item of journal.events(state.spec.id)) if (['lead-started', 'execution-started', 'runtime-resumed', 'package-started', 'package-resumed', 'owner-handed-off'].includes(item.type)) add((item.data as { ref?: unknown })?.ref ?? item.data);
    }
    const here = resolve(process.cwd()).toLowerCase();
    const handle = process.env.ORCA_TERMINAL_HANDLE;
    if ((handle && terminals.has(handle)) || [...worktrees].some(path => here === path || here.startsWith(`${path}\\`) || here.startsWith(`${path}/`))) {
      throw new Error(`${command} is a Human decision and cannot run from an APOS agent terminal or worktree`);
    }
  };
  /** Reads the Goal JSON and the verbatim source; fills `source` when absent, otherwise checks it matches. */
  const goalWithSource = (file: string, sourcePath: string, origin: string) => {
    const raw = readJsonFile(file) as Record<string, unknown>;
    const text = readFileSync(sourcePath, 'utf8');
    const digest = sourceDigest(text);
    const given = raw.source as { sha256?: string } | undefined;
    if (given?.sha256 && given.sha256 !== digest) throw new Error('Goal source sha256 does not match --source file');
    const spec = parseGoalSpec({ ...raw, source: given ?? { path: sourcePath, sha256: digest, capturedAt: new Date().toISOString(), origin } });
    return { spec, text };
  };

  program.command('init').description('initialize .apos in a Git project').option('--skills <dir>', 'folder with apos-core/ and apos-<role>/ skills (default: APOS_SKILLS, else the copy bundled with APOS)').action(async (flags: { skills?: string }) => { await initProject(repo(), flags.skills); write(`Initialized ${repo()}`); });
  program.command('migrate').description('import APOS v1 Goal histories from the repo into the controller log').action(() => withJournal(journal => {
    write(JSON.stringify(journal.importLegacy()));
  }));

  const home = () => options.home ?? controllerHome(repo());
  /** `all` or one role, as the profile and handoff commands take it. */
  const rolesOf = (value: string): Role[] => {
    if (value === 'all') return ROLES;
    if (!(ROLES as string[]).includes(value)) throw new Error(`Unknown role ${value}: use lead, worker, reviewer or all`);
    return [value as Role];
  };
  /** Writes a role profile for the Human, warning about an agent APOS has no screen rules for. */
  const applyProfile = (roles: Role[], change: { agent: string; model?: string; effort?: string }) => {
    setProfile(home(), roles, change);
    if (!(KNOWN_AGENTS as readonly string[]).includes(change.agent)) write(`warning: ${change.agent} is not a known agent (${KNOWN_AGENTS.join(', ')}); Orca must accept it, and its screen is read with every rule set`);
  };
  const profile = program.command('profile').description('which agent, model and effort each role runs with (<controller home>/runtime.json)');
  profile.command('show').action(() => {
    for (const [role, item] of Object.entries(describeProfiles(home()))) write(`${role}: ${item.agent}${item.model ? ` model=${item.model}` : ''}${item.effort ? ` effort=${item.effort}` : ''} (${item.source})`);
  });
  profile.command('set').argument('<role>', 'lead, worker, reviewer or all').requiredOption('--agent <id>', 'Orca agent id: codex, claude, antigravity, ...').option('--model <id>').option('--effort <level>', 'needs --model')
    .description('Human: change the agent of a role; the next dispatch of that role uses it').action((role: string, flags: { agent: string; model?: string; effort?: string }) => withJournal(journal => {
      assertHuman(journal, 'profile set');
      applyProfile(rolesOf(role), flags);
    }));
  profile.command('reset').argument('[role]', 'lead, worker, reviewer or all', 'all').description('Human: back to the default profile').action((role: string) => withJournal(journal => {
    assertHuman(journal, 'profile reset');
    resetProfile(home(), rolesOf(role));
  }));

  const goal = program.command('goal');
  goal.command('create').requiredOption('--file <json>').requiredOption('--source <path>', 'verbatim source the Goal was shaped from').option('--origin <text>', 'who or what produced the source', 'human').action(({ file, source, origin }: { file: string; source: string; origin: string }) => withJournal(journal => {
    const { spec, text } = goalWithSource(file, source, origin);
    journal.appendWithSource(event(spec.id, 'goal-drafted', spec), text);
    write(`Drafted ${spec.id}`);
  }));
  goal.command('list').action(() => withJournal(journal => {
    for (const state of journal.listGoals()) write(`${state.spec.id}\t${state.status}\t${state.spec.outcome}`);
  }));
  // Gate A: the Human approves WHAT, together with the appetite only the controller will see.
  const appetiteOptions = <T extends Command>(command: T): T => command
    .requiredOption('--size <S|M|L>').requiredOption('--max-spend <usd>').requiredOption('--max-minutes <n>')
    .requiredOption('--max-attempts <n>').option('--overrun <stop|ask>', 'what to do when a limit is hit', 'ask') as T;
  type AppetiteFlags = { size: string; maxSpend: string; maxMinutes: string; maxAttempts: string; overrun: string };
  const appetiteOf = (flags: AppetiteFlags) => ({ size: flags.size, maxSpendUsd: Number(flags.maxSpend), maxWallMinutes: Number(flags.maxMinutes), maxAttempts: Number(flags.maxAttempts), overrunPolicy: flags.overrun });
  appetiteOptions(goal.command('approve').argument('<id>')).action((id: string, flags: AppetiteFlags) => withJournal(journal => {
    assertHuman(journal, 'goal approve');
    new GoalRegistryService(journal).approve(id, parseAppetite(appetiteOf(flags))); write(`Approved ${id}`);
  }));
  appetiteOptions(goal.command('appetite').argument('<id>')).requiredOption('--reason <text>').action((id: string, flags: AppetiteFlags & { reason: string }) => withJournal(journal => {
    assertHuman(journal, 'goal appetite');
    journal.append(event(id, 'appetite-set', { appetite: parseAppetite(appetiteOf(flags)), reason: flags.reason }));
    write(`Appetite for ${id} updated`);
  }));
  // Gate B. Selecting a Goal dispatches its Lead, which plans and, in Solo, delivers in the same session.
  goal.command('select').argument('<id>').action((id: string) => withJournalAsync(async journal => {
    assertHuman(journal, 'goal select');
    new GoalRegistryService(journal).select(id); write(`Selected ${id}`);
    try { write(`Dispatched Lead ${id}: ${(await new LeadService(journal, runtime).start(id, repo())).dispatchId}`); }
    catch (error) { write(`Lead not dispatched for ${id}: ${error instanceof Error ? error.message : String(error)}. Retry with \`apos lead start ${id}\`.`); }
  }));
  goal.command('revise').requiredOption('--file <json>').requiredOption('--source <path>').option('--origin <text>', 'who or what produced the source', 'human').action(({ file, source, origin }: { file: string; source: string; origin: string }) => withJournalAsync(async journal => {
    const { spec: revised, text } = goalWithSource(file, source, origin);
    const current = journal.getGoal(revised.id);
    if (!current || revised.version <= current.spec.version) throw new Error('Goal revision must advance the current version');
    await assertExecutionSettled(current, runtime, { includeLead: true });
    journal.appendWithSource(event(revised.id, 'goal-revised', revised), text);
    write(`Revised ${revised.id} v${revised.version}; Human approval required`);
  }));

  const lead = program.command('lead');
  lead.command('recommend').action(() => withJournal(journal => {
    const candidate = new GoalRegistryService(journal).recommend();
    write(candidate ? `${candidate.spec.id}: ${candidate.spec.outcome}` : 'No eligible Goal');
  }));
  lead.command('start').argument('<id>').description('Human: dispatch the Lead of a selected Goal (goal select does this; use it to retry)').action((id: string) => withJournalAsync(async journal => {
    assertHuman(journal, 'lead start');
    write(`Dispatched Lead ${id}: ${(await new LeadService(journal, runtime).start(id, repo())).dispatchId}`);
  }));
  lead.command('wake').argument('<id>').requiredOption('--note <text>', 'your decision, delivered to the Lead').description('Human: wake a Lead that ended its turn before its plan was accepted, on its own terminal').action((id: string, { note }: { note: string }) => withJournalAsync(async journal => {
    assertHuman(journal, 'lead wake');
    if (!note.trim()) throw new Error('Wake note required');
    write(`Woke Lead ${id}: ${await new LeadService(journal, runtime).wake(id, repo(), note)}`);
  }));
  lead.command('propose').requiredOption('--file <json>').action(({ file }: { file: string }) => withJournalAsync(async journal => {
    const parsed = parseExecutionProposal(readJsonFile(file));
    const current = journal.getGoal(parsed.goalId);
    if (!current) throw new Error(`Goal does not exist: ${parsed.goalId}`);
    const leadState = assertLeadTerminal(current, process.env.ORCA_TERMINAL_HANDLE, 'lead propose');
    // The gate compares against the commit the Lead's worktree was cut from: the code it actually read.
    if (parsed.baseCommit && parsed.baseCommit.toLowerCase() !== leadState.ref.baseCommit.toLowerCase()) throw new Error(`Proposal baseCommit ${parsed.baseCommit} differs from the Lead's worktree base ${leadState.ref.baseCommit}`);
    const planned = { ...parsed, baseCommit: leadState.ref.baseCommit };
    const state = current;
    const proposal = planned.sourceSha256 || !state ? planned : { ...planned, sourceSha256: state.spec.source.sha256 };
    if (!state || proposal.goalVersion !== state.spec.version) throw new Error('Proposal targets stale Goal version');
    assertMultiWpPlannable(proposal);
    const mapped = new Set(proposal.acceptanceMapping.map(item => item.acceptanceId));
    if (state.spec.acceptance.some(item => !mapped.has(item.id))) throw new Error('Every Goal acceptance criterion needs a verification mapping');
    if (state.proposal) await assertExecutionSettled(state, runtime);
    journal.append(event(proposal.goalId, state.proposal ? 'proposal-revised' : 'proposal-drafted', proposal));
    write(`Proposed ${proposal.id}`);
  }));

  const execution = program.command('execution');
  // No Human gate on HOW: the Lead commits its plan, the controller machine-checks it and dispatches.
  // A Multi-WP plan only notifies the Human.
  lead.command('commit').argument('<id>').description('Lead commits its plan; the controller checks it and dispatches')
    .option('--terminal <handle>', 'deprecated: APOS knows the Lead terminal it dispatched; if given it must match')
    .option('--worktree <selector>', 'worktree selector of the Lead terminal')
    .action(async (id: string, flags: { terminal?: string; worktree?: string }) => withJournalAsync(async journal => {
      const state = journal.getGoal(id);
      if (!state) throw new Error(`Goal does not exist: ${id}`);
      const leadState = assertLeadTerminal(state, process.env.ORCA_TERMINAL_HANDLE, 'lead commit');
      if (!state.proposal) throw new Error(`Current proposal required: ${id} has no proposal yet (run apos lead propose --file <execution.json> first)`);
      assertMultiWpPlannable(state.proposal);
      if (flags.terminal && flags.terminal !== leadState.ref.terminal) throw new Error(`--terminal ${flags.terminal} is not the Lead terminal APOS dispatched (${leadState.ref.terminal}); leave it out`);
      journal.append(event(id, 'proposal-approved', { by: 'controller', proposalVersion: state.proposal.version }));
      if (state.proposal.mode === 'multi-wp') {
        // Wake-ups go to the Lead's own terminal; this dispatch is its current turn, so none arrives until it ends.
        const ref = currentLeadRef(leadState);
        journal.append(event(id, 'lead-woken', { events: [], dispatchId: ref.dispatchId, terminal: leadState.ref.terminal, worktree: `id:${leadState.ref.worktreeId}`, runId: ref.runId }));
        const notice = { kind: 'multi-wp', goalId: id, packages: Object.keys(state.packages ?? {}), splitRationale: state.proposal.splitRationale, estimatedCost: state.proposal.estimatedCost };
        journal.append(event(id, 'human-notified', notice));
        write(`NOTICE ${id}: Lead chose Multi-WP (${notice.packages.length} packages, est. ${notice.estimatedCost?.spendUsd} USD / ${notice.estimatedCost?.wallMinutes} min): ${notice.splitRationale}`);
        const refs = await new PackageService(journal, packageRuntime()).dispatchReady(id, repo());
        write(`Dispatched ${id}: ${refs.map(ref => ref.dispatchId).join(', ')}`);
      } else {
        const ref = await new SoloService(journal, runtime).adopt(id);
        write(`Accepted ${id}: you (Lead ${ref.dispatchId}) are the Solo owner. Deliver in this worktree and commit your report.`);
      }
  }));
  execution.command('start').argument('<id>').description('record the Lead as the owner of an accepted Solo plan (lead commit does this)').action((id: string) => withJournalAsync(async journal => {
    write((await new SoloService(journal, runtime).adopt(id)).dispatchId);
  }));
  execution.command('checkpoint').argument('<id>').requiredOption('--file <json>').action((id: string, { file }: { file: string }) => withJournal(journal => {
    const checkpoint = readJsonFile(file) as PhaseCheckpoint;
    if (typeof checkpoint.phase !== 'string' || !checkpoint.phase.trim() || typeof checkpoint.progress !== 'string' || !checkpoint.progress.trim() || !Array.isArray(checkpoint.evidenceRefs) || !checkpoint.evidenceRefs.every(item => typeof item === 'string')) throw new Error('Phase checkpoint requires phase, progress and evidenceRefs');
    journal.append(event(id, 'checkpointed', checkpoint));
    write(`Checkpointed ${id}: ${checkpoint.phase}`);
  }));
  execution.command('resume').argument('<id>').action((id: string) => withJournalAsync(async journal => {
    const ref = await new SoloService(journal, runtime).resume(id);
    write(`Resumed ${id}: ${ref.dispatchId}`);
  }));
  execution.command('retry').argument('<id>').requiredOption('--reason <text>').action((id: string, { reason }: { reason: string }) => withJournalAsync(async journal => {
    if (!reason.trim()) throw new Error('Retry reason required');
    if (!journal.getGoal(id)?.resumeIntent) journal.append(event(id, 'checkpointed', { phase: 'repair', progress: reason, evidenceRefs: [] }));
    const ref = await new SoloService(journal, runtime).resume(id);
    write(`Retried ${id}: ${ref.dispatchId}`);
  }));
  execution.command('abandon-intent').argument('<id>').requiredOption('--key <key>').requiredOption('--reason <text>').description('Human: drop a dispatch/resume intent after confirming in Orca that it created nothing').action((id: string, flags: { key: string; reason: string }) => withJournal(journal => {
    assertHuman(journal, 'execution abandon-intent');
    journal.append(event(id, 'intent-abandoned', { key: flags.key, reason: `human: ${flags.reason}` }));
    write(`Abandoned intent ${flags.key} for ${id}`);
  }));
  execution.command('status').argument('<id>').action((id: string) => withJournal(journal => {
    const state = journal.getGoal(id);
    if (!state) throw new Error(`Unknown Goal: ${id}`);
    write(JSON.stringify({ goalId: id, status: state.status, proposalVersion: state.proposal?.version, runtimeRef: state.runtimeRef }));
  }));
  execution.command('reconcile').argument('<id>').action((id: string) => withJournalAsync(async journal => {
    write(`${id}: ${await new SoloService(journal, runtime).reconcile(id)}`);
  }));
  execution.command('verify').argument('<id>').option('--commit <sha>', 'delivery commit under review').action((id: string, { commit }: { commit?: string }) => withJournalAsync(async journal => {
    const result = await new SoloService(journal, runtime).verify(id, commit);
    write(`Verified ${id} at ${result.deliveryCommit}: ${result.acceptanceIds.join(', ')}`);
  }));

  const packages = program.command('package');
  packages.command('add').requiredOption('--file <json>').action(({ file }: { file: string }) => withJournal(journal => {
    const spec = parseWorkPackage(readJsonFile(file));
    new PackageService(journal, packageRuntime()).add(spec.goalId, spec);
    write(`Drafted ${spec.id}`);
  }));
  packages.command('list').argument('<goalId>').action((goalId: string) => withJournal(journal => {
    write(JSON.stringify(journal.getGoal(goalId)?.packages ?? {}));
  }));
  packages.command('ready').argument('<goalId>').action((goalId: string) => withJournal(journal => {
    write(JSON.stringify(new PackageService(journal, packageRuntime()).ready(goalId).map(item => item.id)));
  }));
  packages.command('dispatch').argument('<goalId>').action((goalId: string) => withJournalAsync(async journal => {
    const refs = await new PackageService(journal, packageRuntime()).dispatchReady(goalId, repo());
    write(JSON.stringify(refs));
  }));
  packages.command('reconcile').argument('<goalId>').action((goalId: string) => withJournalAsync(async journal => {
    write(JSON.stringify(await new PackageService(journal, packageRuntime()).reconcile(goalId)));
  }));
  packages.command('evidence').argument('<goalId>').requiredOption('--file <json>').action((goalId: string, { file }: { file: string }) => withJournal(journal => {
    const evidence = new PackageService(journal, packageRuntime()).submitEvidence(goalId, readJsonFile(file));
    write(`Recorded ${evidence.packageId} ${evidence.acceptanceId}`);
  }));
  packages.command('verify').argument('<goalId>').argument('<packageId>').action((goalId: string, packageId: string) => withJournalAsync(async journal => {
    const service = new PackageService(journal, packageRuntime());
    await service.verify(goalId, packageId);
    const refs = await service.dispatchReady(goalId, repo());
    write(`Verified ${packageId}; dispatched ${refs.map(ref => ref.dispatchId).join(', ') || 'none'}`);
  }));
  packages.command('revise').argument('<goalId>').requiredOption('--file <json>').requiredOption('--reason <text>').action((goalId: string, { file, reason }: { file: string; reason: string }) => withJournal(journal => {
    const spec = new PackageService(journal, packageRuntime()).revise(goalId, readJsonFile(file), reason);
    write(`Revised ${spec.id} v${spec.version}`);
  }));
  packages.command('block').argument('<goalId>').argument('<packageId>').requiredOption('--kind <kind>').requiredOption('--note <text>').action((goalId: string, packageId: string, { kind, note }: { kind: 'technical' | 'product' | 'external'; note: string }) => withJournal(journal => {
    new PackageService(journal, packageRuntime()).recordBlocker(goalId, packageId, kind, note);
    write(`Blocked ${packageId}`);
  }));
  packages.command('unblock').argument('<goalId>').argument('<packageId>').requiredOption('--resolution <text>').action((goalId: string, packageId: string, { resolution }: { resolution: string }) => withJournal(journal => {
    new PackageService(journal, packageRuntime()).unblock(goalId, packageId, resolution);
    write(`Unblocked ${packageId}`);
  }));
  packages.command('resume').argument('<goalId>').argument('<packageId>').action((goalId: string, packageId: string) => withJournalAsync(async journal => {
    const ref = await new PackageService(journal, packageRuntime()).resumeStale(goalId, packageId);
    write(`Resumed ${packageId}: ${ref.dispatchId}`);
  }));

  const integration = program.command('integration');
  integration.command('prepare').argument('<goalId>').action((goalId: string) => withJournal(journal => {
    write(JSON.stringify(new IntegrationService(journal, options.inspector).prepare(goalId, repo())));
  }));
  integration.command('complete').argument('<goalId>').requiredOption('--file <json>').action((goalId: string, { file }: { file: string }) => withJournal(journal => {
    const input = parseIntegrationInput(readJsonFile(file));
    const current = journal.getGoal(goalId)?.gate;
    // The controller gates the integration commit itself; a red result wakes the Lead on the next tick.
    if (current?.deliveryCommit !== input.commitRef || current.result !== 'green') {
      const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).run(goalId, repo(), { deliveryCommit: input.commitRef });
      write(`Integration gate ${report.result} on ${input.commitRef}`);
      if (report.result !== 'green') throw new Error(`Integration gate is ${report.result}`);
    }
    new IntegrationService(journal, options.inspector).complete(goalId, repo(), input);
    write(`Integrated and verified ${goalId}`);
  }));
  integration.command('merge').argument('<goalId>').requiredOption('--source <commit>').requiredOption('--target <branch>').action((goalId: string, { source, target }: { source: string; target: string }) => withJournal(journal => {
    const mergeCommit = new MergeService(journal).merge(goalId, repo(), source, target);
    const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).runPostMerge(goalId, repo());
    write(`Merged ${goalId}: ${mergeCommit}; post-merge gate ${report.result}`);
  }));

  const controller = program.command('controller');
  const leasedTick = async () => {
    const leased = await withControllerLease(options.home ?? controllerHome(repo()), () => withJournalAsync(async journal => new ControllerService(journal, runtime as RuntimeAdapter & PackageRuntime, { gate: new GateService(journal, { inspector: options.inspector, ...options.gate }), telemetry: options.telemetry ?? new CodexSessionProbe(), freshLead: (goalId, repoPath) => new HandoffService(journal, runtime, () => loadProfiles(home())).handoff(goalId, { kind: 'lead' }, repoPath) }).tick(repo())));
    return leased;
  };
  controller.command('tick').action(async () => {
    const leased = await leasedTick();
    write(leased.ran ? JSON.stringify(leased.value) : JSON.stringify({ skipped: `another controller (pid ${leased.holder}) is ticking this project` }));
  });
  controller.command('watch').option('--interval-ms <n>', 'mechanical controller interval', '15000').action(async ({ intervalMs }: { intervalMs: string }) => {
    const interval = Number(intervalMs);
    if (!Number.isInteger(interval) || interval < 1000 || interval > 300000) throw new Error('Watch interval must be 1000 to 300000 ms');
    // Seen live: started detached, every Orca call failed with no_active_sender_terminal and the Goal stalled.
    if (!options.runtime && !process.env.ORCA_TERMINAL_HANDLE) throw new Error('controller watch must run inside a live Orca terminal (ORCA_TERMINAL_HANDLE is not set); Orca refuses orchestration calls from a process with no sender terminal');
    let stopped = false;
    const abort = new AbortController();
    const stop = () => { stopped = true; abort.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      let lastReport = '';
      while (!stopped) {
        const leased = await leasedTick();
        const ticks = leased.ran ? leased.value : [];
        const changed = ticks.filter(item => item.dispatched.length || item.recovered.length || item.resumed.length || item.settled.length || item.inboxPending.length || item.errors.length || item.supervised.length);
        const report = JSON.stringify(changed);
        if (changed.length && report !== lastReport) write(report);
        lastReport = report;
        if (!stopped) {
          try { await sleep(interval, undefined, { signal: abort.signal }); }
          catch (error) { if (!stopped) throw error; }
        }
      }
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  });
  const gate = program.command('gate').description('controller-run checks on exact commits; owner claims are not evidence');
  gate.command('run').argument('<goalId>').requiredOption('--commit <sha>', 'delivery or integration commit').option('--base <sha>', 'override the proposal base commit').action((goalId: string, { commit, base }: { commit: string; base?: string }) => withJournal(journal => {
    const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).run(goalId, repo(), { deliveryCommit: commit, baseCommit: base });
    write(JSON.stringify({ gateId: report.gateId, result: report.result, deliveryCommit: report.deliveryCommit, checks: report.checks.map(item => ({ checkId: item.checkId, status: item.status, reason: item.reason, newFailures: item.newFailures })) }));
  }));
  gate.command('confirm').argument('<goalId>').argument('<checkId>').requiredOption('--commit <sha>').requiredOption('--by <name>').requiredOption('--note <text>').action((goalId: string, checkId: string, { commit, by, note }: { commit: string; by: string; note: string }) => withJournal(journal => {
    assertHuman(journal, 'gate confirm');
    new GateService(journal, { inspector: options.inspector, ...options.gate }).confirmManual(goalId, { checkId, deliveryCommit: commit, by, note });
    write(`Confirmed ${checkId} on ${commit}`);
  }));
  const review = program.command('review');
  review.command('submit').argument('<goalId>').requiredOption('--file <json>').action((goalId: string, { file }: { file: string }) => withJournal(journal => {
    assertHuman(journal, 'review submit'); // the controller dispatches and reads reviewers itself; no agent may post a verdict
    const result = new ReviewService(journal).submit(goalId, readJsonFile(file));
    write(`Reviewed ${result.subject}${result.packageId ? ` ${result.packageId}` : ''}: ${result.result}`);
  }));
  const metrics = program.command('metrics');
  metrics.command('show').argument('<goalId>').action((goalId: string) => withJournal(journal => write(JSON.stringify(new MetricsService(journal).show(goalId)))));

  const evidence = program.command('evidence');
  evidence.command('add').argument('<id>').requiredOption('--file <json>').action((id: string, { file }: { file: string }) => withJournal(journal => {
    new VerificationService(journal).submitEvidence(id, readJsonFile(file) as Evidence);
    write(`Recorded evidence for ${id}`);
  }));
  evidence.command('show').argument('<id>').action((id: string) => withJournal(journal => write(JSON.stringify(journal.getGoal(id)?.evidence ?? []))));
  const decision = program.command('decision');
  decision.command('record').argument('<id>').requiredOption('--note <text>').action((id: string, { note }: { note: string }) => withJournal(journal => {
    if (!note.trim()) throw new Error('Decision note required');
    journal.append(event(id, 'decision-logged', { note }));
    write(`Recorded decision for ${id}`);
  }));
  const blocker = program.command('blocker');
  blocker.command('report').argument('<id>').requiredOption('--kind <kind>').requiredOption('--note <text>').action((id: string, { kind, note }: { kind: string; note: string }) => withJournal(journal => {
    if (!['technical', 'product', 'external'].includes(kind) || !note.trim()) throw new Error('Valid blocker kind and note required');
    journal.append(event(id, 'blocked', { kind, note }));
    write(`Blocked ${id}`);
  }));
  blocker.command('resolve').argument('<id>').requiredOption('--note <text>').action((id: string, { note }: { note: string }) => withJournal(journal => {
    if (!note.trim()) throw new Error('Resolution note required');
    assertHuman(journal, 'blocker resolve');
    journal.append(event(id, 'decision-logged', { note }));
    journal.append(event(id, 'unblocked'));
    write(`Unblocked ${id}`);
  }));
  program.command('handoff').argument('<goalId>')
    .description('Human: move a stuck owner (for example out of quota) to a fresh agent on the same worktree; no attempt is spent')
    .option('--package <id>', 'the Worker of this package instead of the Lead').option('--reviewer', 'the reviewer instead of the Lead')
    .option('--agent <id>', 'also make this agent the profile of that role (as `profile set`)').option('--model <id>').option('--effort <level>', 'needs --model')
    .action((goalId: string, flags: { package?: string; reviewer?: boolean; agent?: string; model?: string; effort?: string }) => withJournalAsync(async journal => {
      assertHuman(journal, 'handoff');
      if (flags.package && flags.reviewer) throw new Error('Pass --package or --reviewer, not both');
      if ((flags.model || flags.effort) && !flags.agent) throw new Error('--model and --effort need --agent');
      const target: HandoffTarget = flags.package ? { kind: 'package', packageId: flags.package } : flags.reviewer ? { kind: 'reviewer' } : { kind: 'lead' };
      const role: Role = target.kind === 'package' ? 'worker' : target.kind === 'reviewer' ? 'reviewer' : 'lead';
      // Written first: the runtime reads the role profile when it starts the new agent.
      if (flags.agent) applyProfile([role], { agent: flags.agent, model: flags.model, effort: flags.effort });
      const result = await new HandoffService(journal, runtime, () => loadProfiles(home())).handoff(goalId, target, repo());
      write(`handed off ${goalId}${flags.package ? ` ${flags.package}` : flags.reviewer ? ' reviewer' : ''} to ${loadProfiles(home())[role].agent} (${result.dispatchId})`);
      if (result.warning) write(`warning: ${result.warning}`);
    }));

  const outcome = program.command('outcome');
  // Gate D: the Human reads the Verification Report, decides the outcome and, only here, whether to merge.
  for (const decision of ['close', 'revise', 'stop'] as const) {
    const command = outcome.command(decision).argument('<id>');
    if (decision === 'close') command.option('--merge-to <branch>', 'authorize and perform one merge of the gated commit').option('--by <name>', 'who decided', 'human');
    command.action((id: string, flags: { mergeTo?: string; by?: string }) => withJournalAsync(async journal => {
      assertHuman(journal, `outcome ${decision}`);
      const state = journal.getGoal(id);
      if (decision === 'close') {
        if (state?.status !== 'verified') throw new Error('Verified Goal required before closing');
        if (flags.mergeTo) {
          const merges = new MergeService(journal);
          merges.authorize(id, flags.mergeTo, flags.by ?? 'human');
          const mergeCommit = merges.merge(id, repo(), state.gate!.deliveryCommit, flags.mergeTo);
          const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).runPostMerge(id, repo());
          write(`Merged ${id}: ${mergeCommit}; post-merge gate ${report.result}`);
          if (report.result !== 'green') throw new Error(`Post-merge gate is ${report.result}; Goal stays verified, not closed`);
        }
        if (runtime.releaseWorker) for (const dispatchId of Object.keys(state.settlements ?? {})) await runtime.releaseWorker(dispatchId);
      }
      new VerificationService(journal).recordOutcome(id, decision);
      write(`${decision} ${id}`);
    }));
  }
  program.command('inbox').description('what needs the Human: notices, blocked Goals, verified Goals awaiting outcome').action(() => withJournal(journal => {
    for (const item of buildInbox(journal)) write(`${item.goalId}\t${item.kind}\t${item.detail}`);
  }));
  program.command('ui').description('read-only web view of this project on 127.0.0.1; it never writes controller state').option('--port <n>', 'port to listen on', String(DEFAULT_UI_PORT)).action(async ({ port }: { port: string }) => {
    if (!existsSync(join(repo(), '.apos', 'project.yaml'))) throw new Error('Run apos init first');
    const number = Number(port);
    if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error('--port must be an integer from 0 to 65535');
    const server = await startUi(options.home ?? controllerHome(repo()), number);
    write(`APOS UI: http://127.0.0.1:${(server.address() as { port: number }).port}  (read-only; Ctrl+C to stop)`);
  });
  const finding = program.command('finding');
  finding.command('record').argument('<id>').requiredOption('--kind <intent_gap|bad_plan|patch|defer>').requiredOption('--note <text>').option('--by <name>', 'who found it', 'lead').action((id: string, flags: { kind: string; note: string; by: string }) => withJournal(journal => {
    journal.append(event(id, 'finding-recorded', { kind: flags.kind, note: flags.note, by: flags.by }));
    write(`Recorded ${flags.kind} for ${id}`);
  }));
  await program.parseAsync(argv, { from: 'user' });
}
