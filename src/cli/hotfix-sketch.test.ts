import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hotfixProject, removeTemp, temp } from './hotfix.test-support.js';

const saved = { home: process.env.APOS_HOME, now: process.env.APOS_NOW };
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-hotfix-sketch-home-');
  process.env.APOS_NOW = '2026-11-24T08:00:00.000Z';
});
afterEach(() => {
  process.exitCode = undefined;
  for (const [key, value] of [
    ['APOS_HOME', saved.home],
    ['APOS_NOW', saved.now],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  removeTemp();
});

describe('a hotfix with no criterion yet', () => {
  it('waits for the PM, who revises in the one criterion and keeps the link; then bug approve selects it', async () => {
    const p = await hotfixProject();
    await p.invoke('hotfix', 'on fire', '--commit', p.hotfix, '--on-behalf', 'demo');
    expect(p.out.join('\n')).toContain('"hotfixOf"');
    const inbox = async () => {
      p.out.length = 0;
      await p.invoke('inbox');
      return p.out.join('\n');
    };
    expect(await inbox()).toContain('apos bug approve GOAL-BUG-001');
    await expect(p.invoke('bug', 'approve', 'GOAL-BUG-001', '--on-behalf', 'x')).rejects.toThrow(/sketch/);

    const sketch = p.state('GOAL-BUG-001')!.spec;
    const revised = {
      ...sketch,
      version: 2,
      acceptance: [
        { id: 'AC-1', text: 'on fire', requirementIds: ['R-1'], given: 'g', when: 'w', then: 't', checkIds: ['CHK-1'] },
      ],
      checks: [{ id: 'CHK-1', kind: 'command', command: 'node report.js {report}', expect: 'pass', format: 'junit' }],
      source: undefined,
    };
    writeFileSync(join(p.dir, 'brief.md'), '# on fire, with its criterion\n');
    const file = (name: string, value: unknown) => {
      writeFileSync(join(p.dir, name), JSON.stringify(value));
      return join(p.dir, name);
    };
    const dropped = file('dropped.json', { ...revised, hotfixOf: undefined });
    await expect(p.invoke('goal', 'revise', '--file', dropped, '--source', join(p.dir, 'brief.md'))).rejects.toThrow(
      /hotfix/,
    );
    await p.invoke('goal', 'revise', '--file', file('revised.json', revised), '--source', join(p.dir, 'brief.md'));
    const goal = p.state('GOAL-BUG-001')!;
    expect(goal.spec.version).toBe(2);
    expect(goal.hotfix?.commit).toBe(p.hotfix);
    // The deadline kept running through the revision: the hotfix is still owed.
    process.env.APOS_NOW = '2026-11-26T08:00:00.000Z';
    expect(await inbox()).toContain('quá hạn');
    await p.invoke('bug', 'approve', 'GOAL-BUG-001', '--on-behalf', 'item 1');
    expect(p.state('GOAL-BUG-001')!.status).toBe('selected');
  });
});
