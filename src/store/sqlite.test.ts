import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite.js';
import { spec } from '../domain/fixtures.test-support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SQLite event store', () => {
  it('persists events across process instances and lists Goals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-sqlite-'));
    dirs.push(dir);
    const file = join(dir, 'state.sqlite');
    const first = SqliteStore.open(file);
    const drafted = {
      id: 'EV-1',
      goalId: spec.id,
      type: 'goal-drafted' as const,
      data: spec,
      at: '2026-11-07T00:00:00.000Z',
    };
    first.append(drafted);
    first.close();
    const second = SqliteStore.open(file);
    expect(second.getGoal(spec.id)?.status).toBe('draft');
    expect(second.listGoals().map(goal => goal.spec.id)).toEqual(['GOAL-001']);
    expect(() => second.append(drafted)).toThrow();
    second.close();
  });
});
