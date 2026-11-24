import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSnapshot } from '../ui/read-model.js';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import { hotfixArgs, hotfixProject, removeTemp, temp } from './hotfix.test-support.js';

const saved = { home: process.env.APOS_HOME, now: process.env.APOS_NOW };
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-hotfix-inbox-home-');
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

const accepted = async () => {
  const p = await hotfixProject();
  await p.invoke('hotfix', 'checkout is on fire', '--commit', p.hotfix, ...hotfixArgs, '--on-behalf', 'demo');
  const inbox = async (...flags: string[]) => {
    p.out.length = 0;
    await p.invoke('inbox', ...flags);
    return p.out.join('\n');
  };
  return { ...p, inbox, short: p.hotfix.slice(0, 7) };
};

describe('apos inbox and a hotfix', () => {
  it('shows a hotfix that waits as an ordinary line with its absolute deadline, and the count of those without evidence', async () => {
    const p = await accepted();
    const text = await p.inbox();
    expect(text).toContain(`hotfix ${p.short} đang chờ bằng chứng, hạn 2026-11-25T08:00:00.000Z`);
    expect(text).toContain('hotfix chưa có bằng chứng: 1');
    expect(text).not.toContain('hotfix-overdue');
    expect(text).not.toContain('Inbox is clean');
  });

  it('turns red once the deadline has passed, and says the same thing on every call', async () => {
    const p = await accepted();
    process.env.APOS_NOW = '2026-11-25T08:00:01.000Z';
    const text = await p.inbox();
    expect(text).toContain(`GOAL-BUG-001\tneeds-decision\t`);
    expect(text).toContain(`hotfix ${p.short} quá hạn 2026-11-25T08:00:00.000Z, chưa có bằng chứng`);
    process.env.APOS_NOW = '2026-11-27T08:00:00.000Z';
    // A later look names the same deadline: a ticking "overdue by 3h" would make --wait fire again and again.
    expect(await p.inbox()).toBe(text);
    const json = JSON.parse(await p.inbox('--json')) as { items: { kind: string; detail: string }[] };
    expect(json.items.some(item => item.kind === 'needs-decision' && item.detail.includes('hotfix-overdue'))).toBe(
      true,
    );
  });

  it('is on the same inbox the UI reads, and not an overdue line there with the real clock before the deadline', async () => {
    const p = await accepted();
    const snapshot = buildSnapshot(new ReadOnlyJournal(p.home));
    expect(snapshot.inbox.map(item => item.detail).join('\n')).toContain('hotfix chưa có bằng chứng');
  });

  it('adds "hotfix đỏ ở L1" to the line when L1 was red on the hotfix commit', async () => {
    const p = await hotfixProject();
    writeFileSync(
      join(p.dir, 'report.js'),
      'require(\'fs\').writeFileSync(process.argv[2],\'<testsuite name="s"><testcase classname="s" name="a"><failure message="x"/></testcase></testsuite>\');process.exitCode=1;',
    );
    p.git('add', '-A');
    p.git('commit', '-qm', 'broken suite');
    await p.invoke('hotfix', 'on fire', '--commit', p.git('rev-parse', 'HEAD'), '--on-behalf', 'demo');
    p.out.length = 0;
    await p.invoke('inbox');
    expect(p.out.join('\n')).toMatch(/đang chờ bằng chứng, hạn [^"]*; hotfix đỏ ở L1/);
  });
});

describe('a hotfix that is stopped', () => {
  it('leaves the overdue line, keeps the count, is listed as abandoned and the table says it stays without evidence', async () => {
    const p = await accepted();
    process.env.APOS_NOW = '2026-11-26T08:00:00.000Z';
    expect(await p.inbox()).toContain('quá hạn');
    await p.invoke('outcome', 'stop', 'GOAL-BUG-001', '--on-behalf', 'demo');
    const text = await p.inbox();
    expect(text).not.toContain('quá hạn');
    expect(text).toContain('hotfix chưa có bằng chứng: 1');
    p.out.length = 0;
    await p.invoke('hotfix', 'list');
    expect(p.out.join('\n')).toContain(`GOAL-BUG-001\tbỏ dở\t${p.short}`);
    expect(p.out.join('\n')).toContain('hotfix chưa có bằng chứng: 1');
    p.out.length = 0;
    await p.invoke('goal', 'show', 'GOAL-BUG-001');
    expect(p.out[0]).toBe('hotfix chưa có bằng chứng: 1');
    expect(p.out.join('\n')).toContain('hotfix này mãi chưa có bằng chứng');
  });
});

describe('apos goal show and a hotfix', () => {
  it('opens every Goal with the count while one hotfix has no evidence, and the table of the hotfix Goal says what is owed', async () => {
    const p = await accepted();
    await p.invoke('bug', 'open', 'another bug', ...hotfixArgs);
    p.out.length = 0;
    await p.invoke('goal', 'show', 'GOAL-BUG-002');
    expect(p.out[0]).toBe('hotfix chưa có bằng chứng: 1');
    p.out.length = 0;
    await p.invoke('goal', 'show', 'GOAL-BUG-001');
    const text = p.out.join('\n');
    expect(text).toContain(
      `hotfix ${p.short} chấp nhận khẩn cấp bởi on-behalf:demo lúc 2026-11-24T08:00:00.000Z; chưa có bằng chứng, hạn 2026-11-25T08:00:00.000Z`,
    );
    expect(text).toContain('app.L1 unit ✓');
    expect(text).toContain('duyệt gộp bằng hotfix (on-behalf:demo)');
    process.env.APOS_NOW = '2026-11-26T08:00:00.000Z';
    p.out.length = 0;
    await p.invoke('goal', 'show', 'GOAL-BUG-001');
    expect(p.out.join('\n')).toContain('(QUÁ HẠN)');
  });

  it('says nothing about hotfixes when there is none', async () => {
    const p = await hotfixProject();
    await p.invoke('bug', 'open', 'a bug', ...hotfixArgs);
    p.out.length = 0;
    await p.invoke('goal', 'show', 'GOAL-BUG-001');
    expect(p.out.join('\n')).not.toContain('hotfix');
    p.out.length = 0;
    await p.invoke('inbox');
    expect(p.out.join('\n')).not.toContain('hotfix chưa');
  });
});
