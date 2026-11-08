import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseExecutionProposal, parseGoalSpec, type Evidence, type PhaseCheckpoint } from './domain/contracts.js';
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
import { GateService, committedSourceDigest, type GateOptions } from './app/gate.js';
import { sourceDigest } from './domain/gate.js';
import { execFileSync } from 'node:child_process';
import { parseWorkPackage } from './domain/packages.js';
import { OrcaRuntime, type RuntimeAdapter } from './runtime/orca.js';
import { ProjectJournal } from './store/journal.js';
import { SqliteStore } from './store/sqlite.js';

export type CliOptions = { runtime?: RuntimeAdapter & Partial<PackageRuntime>; inspector?: CommitInspector; gate?: GateOptions; write?: (line: string) => void };

export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const program = new Command();
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runtime = options.runtime ?? new OrcaRuntime();
  const packageRuntime = (): PackageRuntime => {
    if (!runtime.startPackage) throw new Error('Configured runtime cannot start Work Package Workers');
    return runtime as PackageRuntime;
  };
  program.name('apos').description('Local AI Project Orchestration System').version('0.1.0').option('--repo <path>', 'managed Git project', process.cwd());

  const repo = () => resolve(program.opts<{ repo: string }>().repo);
  const withJournal = <T>(fn: (journal: ProjectJournal) => T): T => {
    const path = repo();
    if (!existsSync(join(path, '.apos', 'project.yaml'))) throw new Error('Run apos init first');
    const store = SqliteStore.open(join(path, '.apos', 'state.sqlite'));
    try { return fn(new ProjectJournal(path, store)); } finally { store.close(); }
  };
  const withJournalAsync = async <T>(fn: (journal: ProjectJournal) => Promise<T>): Promise<T> => {
    const path = repo();
    if (!existsSync(join(path, '.apos', 'project.yaml'))) throw new Error('Run apos init first');
    const store = SqliteStore.open(join(path, '.apos', 'state.sqlite'));
    try { return await fn(new ProjectJournal(path, store)); } finally { store.close(); }
  };
  const event = (goalId: string, type: GoalEventType, data?: unknown) => ({ id: randomUUID(), goalId, type, data, at: new Date().toISOString() });
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

  const goal = program.command('goal');
  goal.command('create').requiredOption('--file <json>').requiredOption('--source <path>', 'verbatim source the Goal was shaped from').option('--origin <text>', 'who or what produced the source', 'human').action(({ file, source, origin }: { file: string; source: string; origin: string }) => withJournal(journal => {
    const { spec, text } = goalWithSource(file, source, origin);
    journal.appendWithSource(event(spec.id, 'goal-drafted', spec), text);
    write(`Drafted ${spec.id}`);
  }));
  goal.command('list').action(() => withJournal(journal => {
    for (const state of journal.listGoals()) write(`${state.spec.id}\t${state.status}\t${state.spec.outcome}`);
  }));
  goal.command('approve').argument('<id>').action((id: string) => withJournal(journal => {
    new GoalRegistryService(journal).approve(id, goalId => committedSourceDigest(repo(), goalId)); write(`Approved ${id}`);
  }));
  goal.command('select').argument('<id>').action((id: string) => withJournal(journal => {
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
    const proposal = parsed.baseCommit ? parsed : { ...parsed, baseCommit: execFileSync('git', ['-C', repo(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
    const state = journal.getGoal(proposal.goalId);
    if (!state || proposal.goalVersion !== state.spec.version) throw new Error('Proposal targets stale Goal version');
    const mapped = new Set(proposal.acceptanceMapping.map(item => item.acceptanceId));
    if (state.spec.acceptance.some(item => !mapped.has(item.id))) throw new Error('Every Goal acceptance criterion needs a verification mapping');
    if (state.proposal) await assertExecutionSettled(state, runtime);
    journal.append(event(proposal.goalId, state.proposal ? 'proposal-revised' : 'proposal-drafted', proposal));
    write(`Proposed ${proposal.id}`);
  }));

  const execution = program.command('execution');
  execution.command('approve').argument('<id>').action(async (id: string) => withJournalAsync(async journal => {
      const state = journal.getGoal(id);
      if (!state?.proposal) throw new Error('Current proposal required');
      journal.append(event(id, 'proposal-approved'));
      if (state.proposal.mode === 'multi-wp') {
        const refs = await new PackageService(journal, packageRuntime()).dispatchReady(id, repo());
        write(`Dispatched ${id}: ${refs.map(ref => ref.dispatchId).join(', ')}`);
      } else {
        const ref = await new SoloService(journal, runtime).start(id, repo());
        write(`Dispatched ${id}: ${ref.dispatchId}`);
      }
  }));
  execution.command('start').argument('<id>').action(async (id: string) => {
    const path = repo();
    const store = SqliteStore.open(join(path, '.apos', 'state.sqlite'));
    try { write((await new SoloService(new ProjectJournal(path, store), runtime).start(id, path)).dispatchId); }
    finally { store.close(); }
  });
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
  execution.command('status').argument('<id>').action((id: string) => withJournal(journal => {
    const state = journal.getGoal(id);
    if (!state) throw new Error(`Unknown Goal: ${id}`);
    write(JSON.stringify({ goalId: id, status: state.status, proposalVersion: state.proposal?.version, runtimeRef: state.runtimeRef }));
  }));
  execution.command('reconcile').argument('<id>').action(async (id: string) => {
    const path = repo();
    const store = SqliteStore.open(join(path, '.apos', 'state.sqlite'));
    try { write(`${id}: ${await new SoloService(new ProjectJournal(path, store), runtime).reconcile(id)}`); }
    finally { store.close(); }
  });
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
    new IntegrationService(journal, options.inspector).complete(goalId, repo(), JSON.parse(readFileSync(file, 'utf8')));
    write(`Integrated and verified ${goalId}`);
  }));
  integration.command('merge').argument('<goalId>').requiredOption('--source <commit>').requiredOption('--target <branch>').action((goalId: string, { source, target }: { source: string; target: string }) => withJournal(journal => {
    write(`Merged ${goalId}: ${new MergeService(journal).merge(goalId, repo(), source, target)}`);
  }));

  const controller = program.command('controller');
  controller.command('tick').action(() => withJournalAsync(async journal => {
    write(JSON.stringify(await new ControllerService(journal, runtime as RuntimeAdapter & PackageRuntime).tick(repo())));
  }));
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
        const ticks = await withJournalAsync(async journal => new ControllerService(journal, runtime as RuntimeAdapter & PackageRuntime).tick(repo()));
        const changed = ticks.filter(item => item.dispatched.length || item.recovered.length || item.resumed.length || item.settled.length || item.inboxPending.length || item.errors.length);
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
    journal.append(event(id, 'decision-logged', { note }));
    journal.append(event(id, 'unblocked'));
    write(`Unblocked ${id}`);
  }));
  const outcome = program.command('outcome');
  for (const decision of ['close', 'revise', 'stop'] as const) {
    outcome.command(decision).argument('<id>').action((id: string) => withJournalAsync(async journal => {
      if (decision === 'close' && runtime.releaseWorker) {
        const state = journal.getGoal(id);
        if (state?.status !== 'verified') throw new Error('Verified Goal required before closing');
        for (const dispatchId of Object.keys(state.settlements ?? {})) await runtime.releaseWorker(dispatchId);
      }
      new VerificationService(journal).recordOutcome(id, decision);
      write(`${decision} ${id}`);
    }));
  }
  await program.parseAsync(argv, { from: 'user' });
}
