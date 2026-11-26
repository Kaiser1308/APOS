import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clockOverride } from './clock.js';
import { hotfixArgs, hotfixProject, removeTemp, temp } from './hotfix.test-support.js';

const saved = { home: process.env.APOS_HOME, now: process.env.APOS_NOW };
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-clock-home-');
  delete process.env.APOS_NOW;
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

const WARNING = 'APOS_NOW=2026-11-24T08:00:00.000Z: đồng hồ bị ghi đè, chỉ dùng cho test/demo';

describe('the APOS_NOW override', () => {
  it('is read from the environment, trimmed, and absent when empty', () => {
    expect(clockOverride({})).toBeUndefined();
    expect(clockOverride({ APOS_NOW: '  ' })).toBeUndefined();
    expect(clockOverride({ APOS_NOW: ' 2026-11-24T08:00:00.000Z ' })).toBe('2026-11-24T08:00:00.000Z');
  });

  it('is announced once on stderr by every command that reads the clock, and by none when it is not set', async () => {
    const p = await hotfixProject();
    await p.invoke('inbox');
    await p.invoke('hotfix', 'list');
    expect(p.err.join('\n')).not.toContain('APOS_NOW');
    process.env.APOS_NOW = '2026-11-24T08:00:00.000Z';
    p.err.length = 0;
    for (const args of [['inbox'], ['hotfix', 'list'], ['inbox', '--json']]) {
      await p.invoke(...args);
      expect(p.err.filter(line => line === WARNING)).toHaveLength(1);
      p.err.length = 0;
    }
    await p.invoke('bug', 'open', 'x', ...hotfixArgs);
    await p.invoke('goal', 'show', 'GOAL-BUG-001');
    expect(p.err).toContain(WARNING);
    p.err.length = 0;
    await p.invoke('goal', 'list');
    expect(p.err).toEqual([]);
  });

  it('is written into hotfix-accepted by apos hotfix, and the table says the deadline follows the overridden clock', async () => {
    const p = await hotfixProject();
    await p.invoke('hotfix', 'a', '--commit', p.hotfix, ...hotfixArgs, '--on-behalf', 'demo');
    expect(p.state('GOAL-BUG-001')!.hotfix?.clockOverride).toBeUndefined();
    p.out.length = 0;
    await p.invoke('goal', 'show', 'GOAL-BUG-001');
    expect(p.out.join('\n')).not.toContain('đồng hồ ghi đè');

    const q = await hotfixProject();
    process.env.APOS_NOW = '2026-11-24T08:00:00.000Z';
    await q.invoke('hotfix', 'a', '--commit', q.hotfix, ...hotfixArgs, '--on-behalf', 'demo');
    expect(q.err).toContain(WARNING);
    const accepted = q.events('GOAL-BUG-001').find(item => item.type === 'hotfix-accepted');
    expect((accepted?.data as { clockOverride?: string }).clockOverride).toBe('2026-11-24T08:00:00.000Z');
    expect(q.state('GOAL-BUG-001')!.hotfix?.clockOverride).toBe('2026-11-24T08:00:00.000Z');
    delete process.env.APOS_NOW;
    q.out.length = 0;
    await q.invoke('goal', 'show', 'GOAL-BUG-001');
    expect(q.out.join('\n')).toMatch(
      /chưa có bằng chứng, hạn 2026-11-25T08:00:00\.000Z (?:\(QUÁ HẠN\) )?\(hạn tính theo đồng hồ ghi đè\)/,
    );
  });
});
