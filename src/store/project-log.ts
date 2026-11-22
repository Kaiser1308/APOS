import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ChainFile } from './event-log.js';
import {
  applyProjectEvent,
  replaySetupHistory,
  type ProjectEvent,
  type SetupHistory,
} from '../domain/setup-history.js';

/** Where the project-level stream lives: next to the Goal logs, under a name no Goal id can have. */
export const projectLogPath = (home: string): string => join(home, 'events', '_project.jsonl');

/** Reads the project stream without touching it (no truncation of a torn tail), or [] when there is none. */
export function readProjectEvents(home: string): ProjectEvent[] {
  const path = projectLogPath(home);
  if (!existsSync(path)) return [];
  return new ChainFile<ProjectEvent>(path, '_project').peek();
}

/** The project-level, hash-chained stream: setup probes and approvals. Replayed and checked on every append. */
export class ProjectLog {
  private readonly file: ChainFile<ProjectEvent>;
  constructor(home: string) {
    this.file = new ChainFile(projectLogPath(home), '_project');
  }
  read(): ProjectEvent[] {
    return this.file.read();
  }
  history(): SetupHistory {
    return replaySetupHistory(this.read());
  }
  append(event: ProjectEvent): void {
    const events = this.read();
    if (events.some(item => item.id === event.id)) return;
    applyProjectEvent(replaySetupHistory(events), event);
    this.file.append(event);
  }
}
