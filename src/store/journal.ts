import { applyEvent, type GoalEvent, type GoalState } from '../domain/transitions.js';
import { parseExecutionProposal, parseGoalSpec } from '../domain/contracts.js';
import { parseWorkPackage } from '../domain/packages.js';
import { parseReview } from '../domain/reviews.js';
import { ProjectHistory, committedGoalEvents, withHistoryLock } from './project-history.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteStore } from './sqlite.js';

export interface GoalRepository {
  append(event: GoalEvent): void;
  getGoal(id: string): GoalState | undefined;
  listGoals(): GoalState[];
}

export class ProjectJournal implements GoalRepository {
  private readonly history = new ProjectHistory();
  constructor(private readonly repoPath: string, private readonly store: SqliteStore) { withHistoryLock(this.repoPath, () => this.rebuildIndex()); }

  private rebuildIndex(): void {
    const goalsDir = join(this.repoPath, '.apos', 'goals');
    if (!existsSync(goalsDir)) return;
    for (const entry of readdirSync(goalsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^GOAL-[A-Z0-9-]+$/.test(entry.name)) continue;
      const eventsPath = join(goalsDir, entry.name, 'events.jsonl');
      if (!existsSync(eventsPath)) continue;
      const events = committedGoalEvents(this.repoPath, entry.name);
      if (JSON.stringify(events.map(item => item.id)) !== JSON.stringify(this.store.eventIds(entry.name))) this.store.replaceGoalEvents(entry.name, events);
    }
  }

  append(event: GoalEvent): void {
    withHistoryLock(this.repoPath, () => this.appendLocked(event));
  }

  private appendLocked(event: GoalEvent): void {
    this.rebuildIndex();
    if (this.store.hasEvent(event.id)) return;
    applyEvent(this.store.getGoal(event.goalId), event);
    const documents = [];
    if (event.type === 'goal-drafted' || event.type === 'goal-revised') {
      const spec = parseGoalSpec(event.data);
      documents.push({ path: 'goal.md', content: `# ${spec.id}: ${spec.outcome}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n` });
    }
    if (event.type === 'proposal-drafted' || event.type === 'proposal-revised') {
      const proposal = parseExecutionProposal(event.data);
      documents.push({ path: 'execution.md', content: `# ${proposal.id}: ${proposal.mode}\n\n${proposal.approach}\n\n\`\`\`json\n${JSON.stringify(proposal, null, 2)}\n\`\`\`\n` });
    }
    if (event.type === 'package-added' || event.type === 'package-revised') {
      const spec = parseWorkPackage(event.type === 'package-added' ? event.data : (event.data as { spec: unknown }).spec);
      documents.push({ path: `packages/${spec.id}.md`, content: `# ${spec.id}: ${spec.outcome}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n` });
    }
    if (event.type === 'integration-completed') {
      documents.push({ path: 'integration.md', content: `# ${event.goalId}: integration\n\n\`\`\`json\n${JSON.stringify(event.data, null, 2)}\n\`\`\`\n` });
    }
    if (event.type === 'review-submitted') {
      const review = parseReview(event.data);
      const path = join(this.repoPath, '.apos', 'goals', event.goalId, 'reviews.md');
      const prior = existsSync(path) ? readFileSync(path, 'utf8') : `# Reviews for ${event.goalId}\n`;
      documents.push({ path: 'reviews.md', content: `${prior}\n- ${event.at} ${review.subject}${review.packageId ? ` ${review.packageId} v${review.packageVersion}` : ''}: **${review.result}** by ${review.reviewer} on ${review.commitRef} — ${review.note}\n` });
    }
    if (event.type === 'decision-logged') {
      const path = join(this.repoPath, '.apos', 'goals', event.goalId, 'decisions.md');
      const prior = existsSync(path) ? readFileSync(path, 'utf8') : `# Decisions for ${event.goalId}\n`;
      const note = (event.data as { note?: unknown }).note;
      if (typeof note !== 'string' || !note.trim()) throw new Error('Decision note required');
      documents.push({ path: 'decisions.md', content: `${prior}\n- ${event.at} ${note.trim()}\n` });
    }
    this.history.recordUnderLock(this.repoPath, event.goalId, event, documents);
    this.store.append(event);
  }

  getGoal(id: string): GoalState | undefined { return this.store.getGoal(id); }
  listGoals(): GoalState[] { return this.store.listGoals(); }
}
