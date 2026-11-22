import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  applyEvent,
  isWritableEventType,
  type GoalEvent,
  type GoalEventType,
  type GoalState,
} from '../domain/transitions.js';
import { UserError } from '../domain/errors.js';
import { parseGoalSpec } from '../domain/contracts.js';
import { sourceDigest } from '../domain/gate.js';
import {
  assertGitRoot,
  commitGoalDocuments,
  legacyGoalEvents,
  legacyGoalIds,
  withLock,
  type DocumentUpdate,
} from './project-history.js';
import { EventLog, controllerHome } from './event-log.js';
import { SqliteStore } from './sqlite.js';
import type { GoalRepository } from '../ports/goal-repository.js';

/** Events after which the readable Goal record in the repo is refreshed and committed. */
export const MILESTONES: ReadonlySet<string> = new Set<GoalEventType>([
  'goal-approved',
  'proposal-approved',
  'verified',
  'merge-completed',
  'outcome-accepted',
  'outcome-revised',
  'outcome-stopped',
]);

/**
 * The event log in the controller home is the source of truth; SQLite is a rebuildable index; the
 * managed repo gets readable documents committed only at milestones.
 */
export class ProjectJournal implements GoalRepository {
  readonly home: string;
  private readonly log: EventLog;

  constructor(
    private readonly repoPath: string,
    private readonly store: SqliteStore,
    home?: string,
    private readonly createEvent?: (goalId: string, type: GoalEventType, data: unknown) => GoalEvent,
  ) {
    assertGitRoot(repoPath);
    this.home = home ?? controllerHome(repoPath);
    this.log = new EventLog(this.home);
    withLock(this.home, () => this.rebuildIndex());
  }

  /** Opens the journal with its SQLite index inside the controller home. */
  static open(
    repoPath: string,
    home?: string,
    createEvent?: (goalId: string, type: GoalEventType, data: unknown) => GoalEvent,
  ): { journal: ProjectJournal; close(): void } {
    const dir = home ?? controllerHome(repoPath);
    mkdirSync(dir, { recursive: true });
    const store = SqliteStore.open(join(dir, 'state.sqlite'));
    return { journal: new ProjectJournal(repoPath, store, dir, createEvent), close: () => store.close() };
  }

  private rebuildIndex(): void {
    for (const goalId of this.log.goals()) {
      const events = this.log.read(goalId);
      if (JSON.stringify(events.map(item => item.id)) !== JSON.stringify(this.store.eventIds(goalId)))
        this.store.replaceGoalEvents(goalId, events);
    }
  }

  append(event: GoalEvent): void {
    if (event.type === 'documents-published') throw new Error('Document milestones are controller-only');
    withLock(this.home, () => this.appendLocked(event));
  }

  /** Drafts or revises a Goal together with its verbatim source snapshot. */
  appendWithSource(event: GoalEvent, sourceText: string): void {
    if (event.type !== 'goal-drafted' && event.type !== 'goal-revised')
      throw new Error('Source snapshots attach only to Goal drafts and revisions');
    const spec = parseGoalSpec(event.data);
    if (sourceDigest(sourceText) !== spec.source.sha256)
      throw new Error('Source text does not match the Goal source sha256');
    withLock(this.home, () => {
      const path = this.sourcePath(spec.id, spec.version);
      if (!this.store.hasEvent(event.id)) {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, sourceText, 'utf8');
      }
      this.appendLocked(event);
    });
  }

  private sourcePath(goalId: string, version: number): string {
    return join(this.home, 'sources', goalId, `v${version}.md`);
  }

  currentSourceDigest(goalId: string): string | undefined {
    const state = this.store.getGoal(goalId);
    const path = state && this.sourcePath(goalId, state.spec.version);
    return path && existsSync(path) ? sourceDigest(readFileSync(path, 'utf8')) : undefined;
  }

  artifactRoot(): string {
    return join(this.home, 'artifacts');
  }

  private appendLocked(event: GoalEvent): void {
    this.rebuildIndex();
    if (this.store.hasEvent(event.id)) return;
    if (!isWritableEventType(event.type))
      throw new UserError(`${event.type} is not an APOS v3 event: APOS no longer runs agents`);
    if (this.store.getGoal(event.goalId)?.status === 'legacy')
      throw new UserError(
        `${event.goalId} is a legacy Goal recorded by an older APOS that dispatched agents: it is read-only. Draft a new Goal to continue the work`,
      );
    if (MILESTONES.has(event.type) && !this.createEvent)
      throw new Error('Controller event factory required to publish milestones');
    const next = applyEvent(this.store.getGoal(event.goalId), event);
    this.log.append(event);
    this.store.append(event);
    if (MILESTONES.has(event.type)) this.publish(event.goalId, next, `apos: ${event.goalId} ${event.type}`);
  }

  /** Renders the readable Goal record from controller state. Appetite never leaves the controller. */
  private publish(goalId: string, state: GoalState, message: string): void {
    const docs: DocumentUpdate[] = [];
    const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
    docs.push({
      path: 'goal.md',
      content: `# ${goalId} v${state.spec.version}: ${state.spec.outcome}\n\nStatus: ${state.status}\n\n${json(state.spec)}`,
    });
    const source = this.sourcePath(goalId, state.spec.version);
    if (existsSync(source)) docs.push({ path: 'source.md', content: readFileSync(source, 'utf8') });
    if (state.proposal)
      docs.push({
        path: 'execution.md',
        content: `# ${state.proposal.id} v${state.proposal.version}: ${state.proposal.mode}\n\n${state.proposal.approach}\n\n${json(state.proposal)}`,
      });
    for (const item of Object.values(state.packages ?? {}))
      docs.push({
        path: `packages/${item.spec.id}.md`,
        content: `# ${item.spec.id} v${item.spec.version}: ${item.spec.outcome}\n\n${json(item.spec)}`,
      });
    const events = this.log.read(goalId);
    const decisions = events
      .filter(item => item.type === 'decision-logged')
      .map(item => `- ${item.at} ${(item.data as { note: string }).note}`);
    if (decisions.length)
      docs.push({ path: 'decisions.md', content: `# Decisions for ${goalId}\n\n${decisions.join('\n')}\n` });
    if (state.reviews.length)
      docs.push({
        path: 'reviews.md',
        content: `# Reviews for ${goalId}\n\n${state.reviews.map(review => `- ${review.subject}${review.packageId ? ` ${review.packageId} v${review.packageVersion}` : ''}: **${review.result}** by ${review.reviewer} on ${review.commitRef} — ${review.note}`).join('\n')}\n`,
      });
    if (state.gate) {
      const gate = state.gate;
      docs.push({
        path: 'verification.md',
        content: `# ${goalId}: controller gate ${gate.result}\n\nBase ${gate.baseCommit} → delivery ${gate.deliveryCommit} (${gate.environment.shell}, ${gate.environment.node})\n\n${gate.checks.map(item => `- ${item.checkId}: **${item.status}** — ${item.reason}${item.newFailures.length ? ` (new: ${item.newFailures.join(', ')})` : ''}`).join('\n')}\n`,
      });
    }
    const commit = commitGoalDocuments(this.repoPath, goalId, docs, message);
    if (!commit) return;
    const files: Record<string, string> = {};
    for (const doc of docs) {
      const path = `.apos/goals/${goalId}/${doc.path}`;
      const content = execFileSync('git', ['-C', this.repoPath, 'show', `${commit}:${path}`]);
      files[path] = createHash('sha256').update(content).digest('hex');
    }
    if (!this.createEvent) throw new Error('Controller event factory required to publish milestones');
    const event = this.createEvent(goalId, 'documents-published', { commit, files });
    applyEvent(this.store.getGoal(goalId), event);
    this.log.append(event);
    this.store.append(event);
  }

  /**
   * Imports Goals that APOS v1 kept in `.apos/goals/<id>/events.jsonl` inside the repo. A Goal whose
   * events no longer satisfy the current contract is skipped with its reason; nothing is half-imported.
   */
  importLegacy(): { imported: string[]; skipped: { goalId: string; reason: string }[] } {
    return withLock(this.home, () => {
      const imported: string[] = [];
      const skipped: { goalId: string; reason: string }[] = [];
      for (const goalId of legacyGoalIds(this.repoPath)) {
        if (this.log.read(goalId).length) {
          skipped.push({ goalId, reason: 'already in controller log' });
          continue;
        }
        const events = legacyGoalEvents(this.repoPath, goalId);
        try {
          let state: GoalState | undefined;
          for (const item of events) state = applyEvent(state, item);
          if (!state) throw new Error('no events');
          const snapshot = join(this.repoPath, '.apos', 'goals', goalId, 'source.md');
          if (!existsSync(snapshot) || sourceDigest(readFileSync(snapshot, 'utf8')) !== state.spec.source.sha256)
            throw new Error('source snapshot missing or mismatched');
          const path = this.sourcePath(goalId, state.spec.version);
          mkdirSync(join(path, '..'), { recursive: true });
          writeFileSync(path, readFileSync(snapshot, 'utf8'), 'utf8');
        } catch (error) {
          skipped.push({ goalId, reason: error instanceof Error ? error.message.split('\n')[0] : String(error) });
          continue;
        }
        for (const item of events) this.log.append(item);
        this.store.replaceGoalEvents(goalId, events);
        imported.push(goalId);
      }
      return { imported, skipped };
    });
  }

  getGoal(id: string): GoalState | undefined {
    return this.store.getGoal(id);
  }
  listGoals(): GoalState[] {
    return this.store.listGoals();
  }
  events(id: string): GoalEvent[] {
    return this.store.events(id);
  }
}
