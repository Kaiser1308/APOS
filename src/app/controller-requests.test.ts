import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/sqlite.js';
import { approval, spec } from '../domain/fixtures.test-support.js';
import { DEFAULT_PROFILES } from '../runtime/brief.js';
import { runControllerRequests } from './controller-requests.js';
import type { GoalEventType } from '../domain/transitions.js';
import type { PackageRuntime, RuntimeAdapter } from '../ports/runtime.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

it('settles a request whose work the log shows done after it was queued, without running it again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apos-requests-'));
  dirs.push(dir);
  const store = SqliteStore.open(join(dir, 'state.sqlite'));
  try {
    let n = 0;
    const add = (type: GoalEventType, data?: unknown) =>
      store.append({ id: `R-${++n}`, goalId: spec.id, type, data, at: new Date().toISOString() });
    add('goal-drafted', spec);
    add('goal-approved', approval);
    const request = { kind: 'worker-answer', packageId: 'WP-01', messageId: 'msg_1', text: 'Opaque.', reason: 'Goal' };
    add('controller-requested', { key: 'k1', request });
    // The controller replied and logged it, then stopped before settling the request.
    add('decision-logged', { note: 'Lead answered msg_1', answers: 'msg_1' });
    const replies: string[] = [];
    const unused = async (): Promise<never> => {
      throw new Error('nothing may start');
    };
    const runtime: RuntimeAdapter & PackageRuntime = {
      startLead: unused,
      resumeSolo: unused,
      inspect: unused,
      startPackage: unused,
      async replyMessage(_run: string, id: string) {
        replies.push(id);
      },
    };
    const ran = await runControllerRequests(store, runtime, () => DEFAULT_PROFILES, spec.id, dir);
    expect(replies).toEqual([]);
    expect(ran.errors).toEqual([]);
    expect(ran.done[0]).toMatch(/already done \(decision-logged R-4\)/);
    expect(store.getGoal(spec.id)?.requests).toBeUndefined();
  } finally {
    store.close();
  }
});
