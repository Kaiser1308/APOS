import { DatabaseSync } from 'node:sqlite';
import { applyEvent, type GoalEvent, type GoalState } from '../domain/transitions.js';

export class SqliteStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): SqliteStore {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, goal_id TEXT NOT NULL, payload TEXT NOT NULL)');
    return new SqliteStore(db);
  }

  append(event: GoalEvent): void {
    applyEvent(this.getGoal(event.goalId), event);
    this.db.prepare('INSERT INTO events (id, goal_id, payload) VALUES (?, ?, ?)').run(event.id, event.goalId, JSON.stringify(event));
  }

  getGoal(id: string): GoalState | undefined {
    const rows = this.db.prepare('SELECT payload FROM events WHERE goal_id = ? ORDER BY seq').all(id) as Array<{ payload: string }>;
    return rows.reduce<GoalState | undefined>((state, row) => applyEvent(state, JSON.parse(row.payload) as GoalEvent), undefined);
  }

  listGoals(): GoalState[] {
    const rows = this.db.prepare('SELECT DISTINCT goal_id FROM events ORDER BY goal_id').all() as Array<{ goal_id: string }>;
    return rows.map(row => this.getGoal(row.goal_id)).filter((state): state is GoalState => Boolean(state));
  }

  hasEvent(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM events WHERE id = ?').get(id));
  }

  close(): void { this.db.close(); }
}
