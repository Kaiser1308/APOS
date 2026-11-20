import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { worktreePath } from '../runtime/orca/parse.js';
import type { GoalRepository } from '../ports/goal-repository.js';

const DECISIONS = new Set([
  'package-plan-added',
  'package-removed',
  'package-revised',
  'package-dispatch-approved',
  'package-dispatch-held',
  'package-approval-policy-set',
  'package-failure-decided',
  'multi-time-exhausted',
]);

/** Rebuild the Lead's reading copy from the journal; it is not the source of truth. */
export function writeLeadLog(store: GoalRepository, goalId: string, worktreeId?: string): void {
  const tree = worktreePath(worktreeId);
  if (!tree || !existsSync(tree))
    throw new Error(`Lead worktree unavailable; cannot prepare lead-log.md for ${goalId}`);
  const dir = join(tree, '.apos', 'goals', goalId);
  mkdirSync(dir, { recursive: true });
  const rows = store
    .events(goalId)
    .filter(event => DECISIONS.has(event.type))
    .map(event => {
      const data = event.data as { packageId?: string; spec?: { id?: string }; reason?: string; decision?: string };
      return `- ${event.at} ${event.type} ${data.packageId ?? data.spec?.id ?? ''}: ${data.reason ?? ''}${data.decision ? ` (${data.decision})` : ''}`;
    });
  writeFileSync(
    join(dir, 'lead-log.md'),
    `# ${goalId} Lead coordination\n\nGenerated from the APOS event log. Do not commit this reading copy.\n\n${rows.join('\n')}\n`,
    'utf8',
  );
}
