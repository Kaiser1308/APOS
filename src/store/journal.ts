import { applyEvent, type GoalEvent, type GoalState } from '../domain/transitions.js';
import { parseExecutionProposal, parseGoalSpec } from '../domain/contracts.js';
import { ProjectHistory } from './project-history.js';
import type { SqliteStore } from './sqlite.js';

export interface GoalRepository {
  append(event: GoalEvent): void;
  getGoal(id: string): GoalState | undefined;
  listGoals(): GoalState[];
}

export class ProjectJournal implements GoalRepository {
  private readonly history = new ProjectHistory();
  constructor(private readonly repoPath: string, private readonly store: SqliteStore) {}

  append(event: GoalEvent): void {
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
    this.history.recordSync(this.repoPath, event.goalId, event, documents);
    this.store.append(event);
  }

  getGoal(id: string): GoalState | undefined { return this.store.getGoal(id); }
  listGoals(): GoalState[] { return this.store.listGoals(); }
}
