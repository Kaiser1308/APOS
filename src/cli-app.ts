import { Command } from 'commander';
import { withControllerLease } from './store/lease.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAppetite, parseExecutionProposal, parseGoalSpec, type Evidence, type PhaseCheckpoint } from './domain/contracts.js';
import type { GoalEventType } from './domain/transitions.js';
import { initProject } from './app/init-project.js';
import { SoloService } from './app/solo.js';
import { PackageService, type PackageRuntime } from './app/packages.js';
import { IntegrationService, type CommitInspector } from './app/integration.js';
import { ControllerService } from './app/controller.js';
import { MergeService } from './app/merge.js';
import { ReviewService } from './app/review.js';
import { assertExecutionSettled } from './app/replan.js';
import { MetricsService } from './app/metrics.js';
import { GoalRegistryService } from './app/registry.js';
import { VerificationService } from './app/verification.js';
import { GateService, type GateOptions } from './app/gate.js';
import { CodexSessionProbe, type TelemetryProbe } from './runtime/telemetry.js';
import { loadProfiles } from './runtime/brief.js';
import { controllerHome } from './store/event-log.js';
import { sourceDigest } from './domain/gate.js';
import { execFileSync } from 'node:child_process';
import { parseWorkPackage } from './domain/packages.js';
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
      for (const item of journal.events(state.spec.id)) if (['execution-started', 'runtime-resumed', 'package-started', 'package-resumed'].includes(item.type)) add((item.data as { ref?: unknown })?.ref ?? item.data);
    }
    const here = resolve(process.cwd()).toLowerCase();
    const handle = process.env.ORCA_TERMINAL_HANDLE;
    if ((handle && terminals.has(handle)) || [...worktrees].some(path => here === path || here.startsWith(`${path}\\`) || here.startsWith(`${path}/`))) {
      throw new Error(`${command} is a Human decision and cannot run from an APOS agent terminal or worktree`);
    }
  };
  /** Reads the Goal JSON and the verbatim source; fills `source` when absent, otherwise checks it matches. */
  const goalWithSource = (file: string, sourcePath: string, origin: string) => {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const text = readFileSync(sourcePath, 'utf8');
    const digest = sourceDigest(text);
    const given = raw.source as { sha256?: string } | undefined;
    if (given?.sha256 && given.sha256 !== digest) throw new Error('Goal source sha256 does not match --source file');
    const spec = parseGoalSpec({ ...raw, source: given ?? { path: sourcePath, sha256: digest, capturedAt: new Date().toISOString(), origin } });
    return { spec, text };
  };

  program.command('init').description('initialize .apos in a Git project').action(async () => { await initProject(repo()); write(`Initialized ${repo()}`); });
  program.command('migrate').description('import APOS v1 Goal histories from the repo into the controller log').action(() => withJournal(journal => {
    write(JSON.stringify(journal.importLegacy()));
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
  goal.command('select').argument('<id>').action((id: string) => withJournal(journal => {
    assertHuman(journal, 'goal select');
    new GoalRegistryService(journal).select(id); write(`Selected ${id}`);
  }));
  goal.command('revise').requiredOption('--file <json>').requiredOption('--source <path>').option('--origin <text>', 'who or what produced the source', 'human').action(({ file, source, origin }: { file: string; source: string; origin: string }) => withJournalAsync(async journal => {
    const { spec: revised, text } = goalWithSource(file, source, origin);
    const current = journal.getGoal(revised.id);
    if (!current || revised.version <= current.spec.version) throw new Error('Goal revision must advance the current version');
    await assertExecutionSettled(current, runtime);
    journal.appendWithSource(event(revised.id, 'goal-revised', revised), text);
    write(`Revised ${revised.id} v${revised.version}; Human approval required`);
  }));

  const lead = program.command('lead');
  lead.command('recommend').action(() => withJournal(journal => {
    const candidate = new GoalRegistryService(journal).recommend();
    write(candidate ? `${candidate.spec.id}: ${candidate.spec.outcome}` : 'No eligible Goal');
  }));
  lead.command('propose').requiredOption('--file <json>').action(({ file }: { file: string }) => withJournalAsync(async journal => {
    const parsed = parseExecutionProposal(JSON.parse(readFileSync(file, 'utf8')));
    // The gate compares against the commit the Lead planned from unless the proposal names one.
    const planned = parsed.baseCommit ? parsed : { ...parsed, baseCommit: execFileSync('git', ['-C', repo(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
    const state = journal.getGoal(planned.goalId);
    const proposal = planned.sourceSha256 || !state ? planned : { ...planned, sourceSha256: state.spec.source.sha256 };
    if (!state || proposal.goalVersion !== state.spec.version) throw new Error('Proposal targets stale Goal version');
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
    .option('--terminal <handle>', 'the Lead agent terminal to wake for Multi-WP events (never a Human terminal)')
    .option('--worktree <selector>', 'worktree selector of the Lead terminal')
    .action(async (id: string, flags: { terminal?: string; worktree?: string }) => withJournalAsync(async journal => {
      const state = journal.getGoal(id);
      if (!state?.proposal) throw new Error('Current proposal required');
      journal.append(event(id, 'proposal-approved', { by: 'controller', proposalVersion: state.proposal.version }));
      if (state.proposal.mode === 'multi-wp') {
        if (flags.terminal) journal.append(event(id, 'lead-woken', { events: [], terminal: flags.terminal, worktree: flags.worktree ?? `path:${repo()}` }));
        const notice = { kind: 'multi-wp', goalId: id, packages: Object.keys(state.packages ?? {}), splitRationale: state.proposal.splitRationale, estimatedCost: state.proposal.estimatedCost };
        journal.append(event(id, 'human-notified', notice));
        write(`NOTICE ${id}: Lead chose Multi-WP (${notice.packages.length} packages, est. ${notice.estimatedCost?.spendUsd} USD / ${notice.estimatedCost?.wallMinutes} min): ${notice.splitRationale}`);
        const refs = await new PackageService(journal, packageRuntime()).dispatchReady(id, repo());
        write(`Dispatched ${id}: ${refs.map(ref => ref.dispatchId).join(', ')}`);
      } else {
        const ref = await new SoloService(journal, runtime).start(id, repo());
        write(`Dispatched ${id}: ${ref.dispatchId}`);
      }
  }));
  execution.command('start').argument('<id>').action((id: string) => withJournalAsync(async journal => {
    write((await new SoloService(journal, runtime).start(id, repo())).dispatchId);
  }));
  execution.command('checkpoint').argument('<id>').requiredOption('--file <json>').action((id: string, { file }: { file: string }) => withJournal(journal => {
    const checkpoint = JSON.parse(readFileSync(file, 'utf8')) as PhaseCheckpoint;
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
    const spec = parseWorkPackage(JSON.parse(readFileSync(file, 'utf8')));
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
    const evidence = new PackageService(journal, packageRuntime()).submitEvidence(goalId, JSON.parse(readFileSync(file, 'utf8')));
    write(`Recorded ${evidence.packageId} ${evidence.acceptanceId}`);
  }));
  packages.command('verify').argument('<goalId>').argument('<packageId>').action((goalId: string, packageId: string) => withJournalAsync(async journal => {
    const service = new PackageService(journal, packageRuntime());
    await service.verify(goalId, packageId);
    const refs = await service.dispatchReady(goalId, repo());
    write(`Verified ${packageId}; dispatched ${refs.map(ref => ref.dispatchId).join(', ') || 'none'}`);
  }));
  packages.command('revise').argument('<goalId>').requiredOption('--file <json>').requiredOption('--reason <text>').action((goalId: string, { file, reason }: { file: string; reason: string }) => withJournal(journal => {
    const spec = new PackageService(journal, packageRuntime()).revise(goalId, JSON.parse(readFileSync(file, 'utf8')), reason);
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
    const input = JSON.parse(readFileSync(file, 'utf8')) as { commitRef: string };
    const current = journal.getGoal(goalId)?.gate;
    // The controller gates the integration commit itself; a red result wakes the Lead on the next tick.
    if (current?.deliveryCommit !== input.commitRef || current.result !== 'green') {
      const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).run(goalId, repo(), { deliveryCommit: input.commitRef });
      write(`Integration gate ${report.result} on ${input.commitRef}`);
      if (report.result !== 'green') throw new Error(`Integration gate is ${report.result}`);
    }
    new IntegrationService(journal, options.inspector).complete(goalId, repo(), JSON.parse(readFileSync(file, 'utf8')));
    write(`Integrated and verified ${goalId}`);
  }));
  integration.command('merge').argument('<goalId>').requiredOption('--source <commit>').requiredOption('--target <branch>').action((goalId: string, { source, target }: { source: string; target: string }) => withJournal(journal => {
    const mergeCommit = new MergeService(journal).merge(goalId, repo(), source, target);
    const report = new GateService(journal, { inspector: options.inspector, ...options.gate }).runPostMerge(goalId, repo());
    write(`Merged ${goalId}: ${mergeCommit}; post-merge gate ${report.result}`);
  }));

  const controller = program.command('controller');
  const leasedTick = async () => {
    const leased = await withControllerLease(options.home ?? controllerHome(repo()), () => withJournalAsync(async journal => new ControllerService(journal, runtime as RuntimeAdapter & PackageRuntime, { gate: new GateService(journal, { inspector: options.inspector, ...options.gate }), telemetry: options.telemetry ?? new CodexSessionProbe() }).tick(repo())));
    return leased;
  };
  controller.command('tick').action(async () => {
    const leased = await leasedTick();
    write(leased.ran ? JSON.stringify(leased.value) : JSON.stringify({ skipped: `another controller (pid ${leased.holder}) is ticking this project` }));
  });
  controller.command('watch').option('--interval-ms <n>', 'mechanical controller interval', '15000').action(async ({ intervalMs }: { intervalMs: string }) => {
    const interval = Number(intervalMs);
    if (!Number.isInteger(interval) || interval < 1000 || interval > 300000) throw new Error('Watch interval must be 1000 to 300000 ms');
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
    const result = new ReviewService(journal).submit(goalId, JSON.parse(readFileSync(file, 'utf8')));
    write(`Reviewed ${result.subject}${result.packageId ? ` ${result.packageId}` : ''}: ${result.result}`);
  }));
  const metrics = program.command('metrics');
  metrics.command('show').argument('<goalId>').action((goalId: string) => withJournal(journal => write(JSON.stringify(new MetricsService(journal).show(goalId)))));

  const evidence = program.command('evidence');
  evidence.command('add').argument('<id>').requiredOption('--file <json>').action((id: string, { file }: { file: string }) => withJournal(journal => {
    new VerificationService(journal).submitEvidence(id, JSON.parse(readFileSync(file, 'utf8')) as Evidence);
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
    for (const state of journal.listGoals()) {
      const notices = journal.events(state.spec.id).filter(item => item.type === 'human-notified').map(item => item.data);
      if (state.status === 'blocked') write(`${state.spec.id}\tneeds-decision\t${JSON.stringify(state.blocker)}`);
      if (state.status === 'verified') write(`${state.spec.id}\tawaiting-outcome\tgate ${state.gate?.result} on ${state.gate?.deliveryCommit}`);
      for (const notice of notices) write(`${state.spec.id}\tnotice\t${JSON.stringify(notice)}`);
    }
  }));
  const finding = program.command('finding');
  finding.command('record').argument('<id>').requiredOption('--kind <intent_gap|bad_plan|patch|defer>').requiredOption('--note <text>').option('--by <name>', 'who found it', 'lead').action((id: string, flags: { kind: string; note: string; by: string }) => withJournal(journal => {
    journal.append(event(id, 'finding-recorded', { kind: flags.kind, note: flags.note, by: flags.by }));
    write(`Recorded ${flags.kind} for ${id}`);
  }));
  await program.parseAsync(argv, { from: 'user' });
}
