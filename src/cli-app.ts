import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseExecutionProposal, parseGoalSpec, type Evidence } from './domain/contracts.js';
import type { GoalEventType } from './domain/transitions.js';
import { initProject } from './app/init-project.js';
import { SoloService } from './app/solo.js';
import { VerificationService } from './app/verification.js';
import { OrcaRuntime, type RuntimeAdapter } from './runtime/orca.js';
import { ProjectJournal } from './store/journal.js';
import { SqliteStore } from './store/sqlite.js';

export type CliOptions = { runtime?: RuntimeAdapter; write?: (line: string) => void };

export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const program = new Command();
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runtime = options.runtime ?? new OrcaRuntime();
  program.name('apos').description('Local AI Project Orchestration System').version('0.1.0').option('--repo <path>', 'managed Git project', process.cwd());

  const repo = () => resolve(program.opts<{ repo: string }>().repo);
  const withJournal = <T>(fn: (journal: ProjectJournal) => T): T => {
    const path = repo();
    if (!existsSync(join(path, '.apos', 'project.yaml'))) throw new Error('Run apos init first');
    const store = SqliteStore.open(join(path, '.apos', 'state.sqlite'));
    try { return fn(new ProjectJournal(path, store)); } finally { store.close(); }
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
  execution.command('approve').argument('<id>').action(async (id: string) => {
    const path = repo();
    const store = SqliteStore.open(join(path, '.apos', 'state.sqlite'));
    try {
      const journal = new ProjectJournal(path, store);
      const state = journal.getGoal(id);
      if (!state?.proposal || state.proposal.mode === 'multi-wp') throw new Error('Solo proposal required for this execution path');
      journal.append(event(id, 'proposal-approved'));
      const ref = await new SoloService(journal, runtime).start(id, path);
      write(`Dispatched ${id}: ${ref.dispatchId}`);
    } finally { store.close(); }
  });
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
  execution.command('verify').argument('<id>').action((id: string) => withJournal(journal => {
    const result = new VerificationService(journal).verify(id);
    write(`Verified ${id}: ${result.acceptanceIds.join(', ')}`);
  }));

  const evidence = program.command('evidence');
  evidence.command('add').argument('<id>').requiredOption('--file <json>').action((id: string, { file }: { file: string }) => withJournal(journal => {
    new VerificationService(journal).submitEvidence(id, JSON.parse(readFileSync(file, 'utf8')) as Evidence);
    write(`Recorded evidence for ${id}`);
  }));
  evidence.command('show').argument('<id>').action((id: string) => withJournal(journal => write(JSON.stringify(journal.getGoal(id)?.evidence ?? []))));
  const outcome = program.command('outcome');
  for (const decision of ['close', 'revise', 'stop'] as const) {
    outcome.command(decision).argument('<id>').action((id: string) => withJournal(journal => {
      new VerificationService(journal).recordOutcome(id, decision);
      write(`${decision} ${id}`);
    }));
  }
  await program.parseAsync(argv, { from: 'user' });
}
