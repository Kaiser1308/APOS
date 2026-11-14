import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quotaMessage, rulesFor, SCREENS, unsentBrief } from './screens.js';

const fixture = (agent: string, name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/screens/${agent}/${name}.txt`, import.meta.url)), 'utf8')
    .split(/\r?\n/)
    .filter((line, index, all) => index < all.length - 1 || line);

describe('screen rules per agent', () => {
  it('codex keeps its existing rules', () => {
    expect(unsentBrief('codex', ['› [Pasted Content 7848 chars]', '  GPT-6.1 Terra medium'])).toBe(true);
    expect(unsentBrief('codex', ['• Working (50s • esc to interrupt)', '› Ask Codex to do anything'])).toBe(false);
  });

  it('antigravity: unsent only on the unsent sample', () => {
    expect(unsentBrief('antigravity', fixture('antigravity', 'unsent'))).toBe(true);
    expect(unsentBrief('antigravity', fixture('antigravity', 'idle'))).toBe(false);
    expect(unsentBrief('antigravity', fixture('antigravity', 'working'))).toBe(false);
    expect(SCREENS.antigravity.working(fixture('antigravity', 'working'))).toBe(true);
    expect(SCREENS.antigravity.working(fixture('antigravity', 'idle'))).toBe(false);
  });

  it('claude runs as an Orca chat: never an unsent composer; a pending tool call is working', () => {
    expect(unsentBrief('claude', fixture('claude', 'idle'))).toBe(false);
    expect(SCREENS.claude.working(fixture('claude', 'working'))).toBe(true);
    expect(SCREENS.claude.working(fixture('claude', 'idle'))).toBe(false);
  });

  it('names the quota line', () => {
    expect(quotaMessage('claude', fixture('claude', 'quota-weekly'))).toBe(
      "You've hit your weekly limit · resets 1am (Asia/Ho_Chi_Minh)",
    );
    expect(quotaMessage('claude', fixture('claude', 'quota-5h'))).toMatch(/5-hour limit · resets 12:20pm/);
    expect(quotaMessage('codex', fixture('codex', 'quota'))).toMatch(/^You’ve hit your usage limit\./);
    expect(quotaMessage('antigravity', fixture('claude', 'quota-weekly'))).toBeUndefined();
  });

  it('does not fire on an agent discussing limits, or while it is working', () => {
    expect(
      quotaMessage('claude', [
        '[assistant] The API returns 429 when you hit your rate limit; add a retry.',
        '[assistant] Note: "You\'ve hit your weekly limit" is what Claude prints.',
      ]),
    ).toBeUndefined();
    expect(
      quotaMessage('codex', [
        '• The test expects the string You’ve hit your usage limit in the banner.',
        '› Ask Codex to do anything',
      ]),
    ).toBeUndefined();
    expect(
      quotaMessage('claude', [...fixture('claude', 'quota-weekly'), '[assistant] [tool Bash] {"command":"npm test"}']),
    ).toBeUndefined();
  });

  it('an unknown agent tries every rule set', () => {
    expect(rulesFor(undefined)).toHaveLength(3);
    expect(rulesFor('cursor')).toHaveLength(3);
    expect(rulesFor('claude')).toEqual([SCREENS.claude]);
    expect(quotaMessage(undefined, fixture('claude', 'quota-weekly'))).toMatch(/weekly limit/);
  });
});

describe("quota lines are the agent's own last word, not text it printed", () => {
  it('ignores an indented line, and a quota line followed by more agent output', () => {
    expect(
      quotaMessage('codex', [
        '• Ran cat banner.txt',
        '  You’ve hit your usage limit · resets 3pm',
        '› Ask Codex to do anything',
      ]),
    ).toBeUndefined();
    expect(quotaMessage('claude', ["  You've hit your weekly limit · resets 1am", '[assistant] done'])).toBeUndefined();
    expect(
      quotaMessage('claude', [
        "[assistant] You've hit your weekly limit · resets 1am",
        '[user] Continue',
        '[assistant] Picking up where I left off.',
      ]),
    ).toBeUndefined();
    expect(
      quotaMessage('codex', [
        '■ You’ve hit your usage limit. Try again later.',
        '',
        '• Ran npm test',
        '› Ask Codex to do anything',
      ]),
    ).toBeUndefined();
  });
});
