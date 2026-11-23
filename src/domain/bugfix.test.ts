import { describe, expect, it } from 'vitest';
import { bugCheckFromSetup, bugGoalSpec, bugPart, bugSourceText, nextBugId } from './bugfix.js';
import { goalKind } from './contracts.js';
import { sourceDigest } from './gate.js';
import { parseProjectSetup } from './project-setup.js';
import { yamlCodec } from './setup-codec.js';

const report = {
  description: 'Order total is wrong with a 0% discount code',
  given: 'a cart of 40 and the code FREE0 (0% off)',
  when: 'the total is computed',
  then: 'the total is 40',
  reproHint: 'src/orders.ts',
};
const setup = (parts: Record<string, unknown>) =>
  parseProjectSetup(yamlCodec.stringify({ schemaVersion: 2, parts }), yamlCodec).setup;
const part = (layers: unknown) => ({ root: '.', layers });

describe('bug Goal', () => {
  it('numbers GOAL-BUG-n apart from ordinary Goal ids', () => {
    expect(nextBugId(['GOAL-001', 'GOAL-014'])).toBe('GOAL-BUG-001');
    expect(nextBugId(['GOAL-BUG-001', 'GOAL-BUG-007', 'GOAL-020'])).toBe('GOAL-BUG-008');
  });
  it('is a bugfix Goal with one red-green criterion whose source is the report, hashed', () => {
    const spec = bugGoalSpec({
      id: 'GOAL-BUG-001',
      report,
      check: { command: 'npm test' },
      now: '2026-11-23T00:00:00.000Z',
    });
    expect(goalKind(spec)).toBe('bugfix');
    expect(spec.acceptance).toHaveLength(1);
    expect(spec.acceptance[0]).toMatchObject({ given: report.given, when: report.when, then: report.then });
    expect(spec.source.sha256).toBe(sourceDigest(bugSourceText(report)));
    expect(bugSourceText(report)).toContain(report.description);
    expect(bugSourceText(report)).toContain('src/orders.ts');
  });
  it('takes its check from the acceptance tool of the part, else the unit tool', () => {
    const l1 = { id: 'u', command: 'pytest -q', format: 'exit' };
    const l2 = { id: 'a', command: 'vitest --reporter=junit --outputFile={report}', format: 'junit' };
    expect(bugCheckFromSetup(setup({ app: part({ L1: [l1], L2: [l2] }) }), 'app')).toEqual({
      command: l2.command,
      format: 'junit',
    });
    expect(bugCheckFromSetup(setup({ app: part({ L1: [l1] }) }), 'app')).toEqual({ command: 'pytest -q' });
    expect(() => bugCheckFromSetup(setup({ app: part({ L5: [l1] }) }), 'app')).toThrow(/no L1 or L2 tool/);
  });
  it('needs --part when the setup has several parts', () => {
    const two = setup({ api: part({}), web: { ...part({}), root: 'web' } });
    expect(() => bugPart(two, undefined)).toThrow(/--part/);
    expect(bugPart(two, 'web')).toBe('web');
    expect(() => bugPart(two, 'nope')).toThrow(/api, web/);
    expect(bugPart(setup({ app: part({}) }), undefined)).toBe('app');
  });
});
