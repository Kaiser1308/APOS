import { parseGoalSpec, type GoalSpec } from './contracts.js';
import { UserError } from './errors.js';
import { sourceDigest } from './gate.js';
import type { LayerSpec, ProjectSetup } from './project-setup.js';

/** What `bug approve` asks the Human to approve unless a flag says otherwise: a small bug, an hour, three red gates. */
export const BUG_APPETITE = { size: 'S', maxWallMinutes: 60, maxAttempts: 3, overrun: 'ask' } as const;
/** The `via` that `bug approve` writes on its three events, and what the assurance table reads back. */
export const BUG_APPROVE_VIA = 'bug approve';

export type BugReport = {
  description: string;
  given: string;
  when: string;
  then: string;
  reproHint?: string;
  part?: string;
};

/** The next free `GOAL-BUG-<n>`; ordinary Goal ids are never touched. */
export function nextBugId(existing: string[]): string {
  const used = existing.map(id => /^GOAL-BUG-(\d+)$/.exec(id)?.[1]).filter((n): n is string => n !== undefined);
  const next = Math.max(0, ...used.map(Number)) + 1;
  return `GOAL-BUG-${String(next).padStart(3, '0')}`;
}

/** The verbatim source of a bug Goal: the description and the three flags, in the order a Tester reads them. */
export function bugSourceText(report: BugReport): string {
  const lines = [
    '# Lỗi',
    '',
    report.description,
    '',
    `- Cho trước: ${report.given}`,
    `- Khi: ${report.when}`,
    `- Thì: ${report.then}`,
  ];
  if (report.reproHint) lines.push(`- Gợi ý tái hiện (nơi lỗi hiện ra): ${report.reproHint}`);
  if (report.part) lines.push(`- Phần: ${report.part}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The check a bug Goal is delivered against, taken from the approved setup: the acceptance tool of the part, else its
 * unit tool. Only a tool that reads as pass or fail from the exit code or a JUnit report can stand in for a check.
 */
export function bugCheckFromSetup(setup: ProjectSetup, part: string): { command: string; format?: 'junit' } {
  const layers = setup.parts[part]?.layers ?? {};
  const usable = (tool: LayerSpec) => (tool.when ?? 'always') === 'always' && ['exit', 'junit'].includes(tool.format);
  const tool = [...(layers.L2 ?? []), ...(layers.L1 ?? [])].find(usable);
  if (!tool)
    throw new UserError(
      `the setup has no L1 or L2 tool for part "${part}" that reports pass or fail: add one to the setup and approve it, then open the bug again`,
    );
  return { command: tool.command, ...(tool.format === 'junit' ? { format: 'junit' as const } : {}) };
}

/** The part a bug lives in: the one asked for, or the setup's only part. */
export function bugPart(setup: ProjectSetup, asked?: string): string {
  const names = Object.keys(setup.parts);
  if (asked) {
    if (!setup.parts[asked]) throw new UserError(`--part ${asked}: the setup has parts ${names.join(', ')}`);
    return asked;
  }
  if (names.length !== 1) throw new UserError(`the setup has parts ${names.join(', ')}: say which with --part`);
  return names[0]!;
}

/** The Goal of a bug report: one requirement, one red-green criterion, one check, a scope the hint or the part names. */
export function bugGoalSpec(input: {
  id: string;
  report: BugReport;
  check: { command: string; format?: 'junit' };
  now: string;
}): GoalSpec {
  const { id, report, check } = input;
  const text = bugSourceText(report);
  return parseGoalSpec({
    id,
    version: 1,
    kind: 'bugfix',
    ...(report.reproHint ? { reproHint: report.reproHint } : {}),
    ...(report.part ? { part: report.part } : {}),
    outcome: report.description,
    source: { path: 'bug-report', sha256: sourceDigest(text), capturedAt: input.now, origin: 'human' },
    requirements: [{ id: 'R-1', sourceSpan: 'bug report', text: report.description, disposition: 'acceptance' }],
    scope: [report.reproHint ?? (report.part ? `part ${report.part}` : 'the code behind the bug')],
    acceptance: [
      {
        id: 'AC-1',
        text: report.description,
        requirementIds: ['R-1'],
        given: report.given,
        when: report.when,
        then: report.then,
        checkIds: ['CHK-1'],
      },
    ],
    checks: [
      {
        id: 'CHK-1',
        kind: 'command',
        command: check.command,
        expect: 'pass',
        ...(check.format ? { format: check.format } : {}),
      },
    ],
  });
}
