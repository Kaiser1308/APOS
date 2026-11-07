import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseExecutionProposal, parseGoalSpec, type Evidence } from './domain/contracts.js';
import type { GoalEventType } from './domain/transitions.js';
import { initProject } from './app/init-project.js';
import { SoloService } from './app/solo.js';
import { PackageService, type PackageRuntime } from './app/packages.js';
import { IntegrationService, type CommitInspector } from './app/integration.js';
import { VerificationService } from './app/verification.js';
import { parseWorkPackage } from './domain/packages.js';
import { OrcaRuntime, type RuntimeAdapter } from './runtime/orca.js';
import { ProjectJournal } from './store/journal.js';
import { SqliteStore } from './store/sqlite.js';

export type CliOptions = { runtime?: RuntimeAdapter & Partial<PackageRuntime>; inspector?: CommitInspector; write?: (line: string) => void };

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

  program.command('init').description('initialize .apos in a Git project').action(async () => { await initProject(repo()); write(`Initialized ${repo()}`); });

  const goal = program.command('goal');
  goal.command('create').requiredOption('--file <json>').action(({ file }: { file: string }) => withJournal(journal => {
    const spec = parseGoalSpec(JSON.parse(readFileSync(file, 'utf8')));
    journal.append(event(spec.id, 'goal-drafted', spec));
    write(`Drafted ${spec.id}`);
  }));
  goal.command('list').action(() => withJournal(journal => {
    for (const state of journal.listGoals()) write(`${state.spec.id}\t${state.status}\t${state.spec.outcome}`);
  }));
  goal.command('approve').argument('<id>').action((id: string) => withJournal(journal => {
    journal.append(event(id, 'goal-approved')); write(`Approved ${id}`);
  }));
  goal.command('select').argument('<id>').action((id: string) => withJournal(journal => {
    journal.append(event(id, 'goal-selected')); write(`Selected ${id}`);
  }));

  const lead = program.command('lead');
  lead.command('recommend').action(() => withJournal(journal => {
    const candidate = journal.listGoals().filter(state => state.status === 'approved' && state.spec.dependencies.every(id => journal.getGoal(id)?.status === 'closed')).sort((a, b) => a.spec.priority - b.spec.priority)[0];
    write(candidate ? `${candidate.spec.id}: ${candidate.spec.outcome}` : 'No eligible Goal');
  }));
  lead.command('propose').requiredOption('--file <json>').action(({ file }: { file: string }) => withJournal(journal => {
    const proposal = parseExecutionProposal(JSON.parse(readFileSync(file, 'utf8')));
    const state = journal.getGoal(proposal.goalId);
    if (!state || proposal.goalVersion !== state.spec.version) throw new Error('Proposal targets stale Goal version');
    const mapped = new Set(proposal.acceptanceMapping.map(item => item.acceptanceId));
    if (state.spec.acceptance.some(item => !mapped.has(item.id))) throw new Error('Every Goal acceptance criterion needs a verification mapping');
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
  execution.command('verify').argument('<id>').action((id: string) => withJournal(journal => {
    const result = new VerificationService(journal).verify(id);
    write(`Verified ${id}: ${result.acceptanceIds.join(', ')}`);
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
    outcome.command(decision).argument('<id>').action((id: string) => withJournal(journal => {
      new VerificationService(journal).recordOutcome(id, decision);
      write(`${decision} ${id}`);
    }));
  }
  await program.parseAsync(argv, { from: 'user' });
}
