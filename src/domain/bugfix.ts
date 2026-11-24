import { parseExecutionProposal, parseGoalSpec, type ExecutionProposal, type GoalSpec } from './contracts.js';
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

export type BugCheck = { command: string; format?: 'junit'; report?: string };

/**
 * The check a bug Goal is delivered against, taken from the approved setup: the acceptance tool of the part, else its
 * unit tool. Only a tool that reads as pass or fail from the exit code or a JUnit report can stand in for a check.
 * A tool runs in the part's root and a Goal check at the top of the checkout, so the command moves into the root and a
 * report path (relative to the root for a tool, to the checkout for a check) is prefixed with it.
 */
export function bugCheckFromSetup(setup: ProjectSetup, part: string): BugCheck {
  const where = setup.parts[part];
  const layers = where?.layers ?? {};
  const usable = (tool: LayerSpec) => (tool.when ?? 'always') === 'always' && ['exit', 'junit'].includes(tool.format);
  const tool = [...(layers.L2 ?? []), ...(layers.L1 ?? [])].find(usable);
  if (!tool)
    throw new UserError(
      `the setup has no L1 or L2 tool for part "${part}" that reports pass or fail: add one to the setup and approve it, then open the bug again`,
    );
  const root = where?.root ?? '.';
  return {
    command: root === '.' ? tool.command : `cd "${root}" && ${tool.command}`,
    ...(tool.format === 'junit' ? { format: 'junit' as const } : {}),
    ...(tool.report ? { report: root === '.' ? tool.report : `${root}/${tool.report}` } : {}),
  };
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
  check: BugCheck;
  now: string;
  /** `apos hotfix`: the source of the Goal is the hotfix report, and the Goal is linked to the commit let through. */
  sourceText?: string;
  hotfixOf?: GoalSpec['hotfixOf'];
}): GoalSpec {
  const { id, report, check } = input;
  const text = input.sourceText ?? bugSourceText(report);
  return parseGoalSpec({
    id,
    version: 1,
    kind: 'bugfix',
    ...(report.reproHint ? { reproHint: report.reproHint } : {}),
    ...(report.part ? { part: report.part } : {}),
    ...(input.hotfixOf ? { hotfixOf: input.hotfixOf } : {}),
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
        ...(check.report ? { report: check.report } : {}),
      },
    ],
  });
}

/**
 * The Solo plan of a bug: the Tester reproduces it with a test, the Worker fixes it. `root` is the root of the part the
 * bug lives in (the Worker may change code there), `stubs` the modules the reproduction imports (the hint, unless the
 * Lead names others). A Goal with no setup has no root: the plan then carries no `paths`.
 */
export function bugfixProposal(input: {
  goal: GoalSpec;
  version: number;
  baseCommit: string;
  root?: string;
  stubs: string[];
  /** A hotfix Goal: the files the hotfix changed, which the delivery may change and nothing else (they replace the part's root). */
  paths?: string[];
}): ExecutionProposal {
  const { goal, root } = input;
  const stubs = input.stubs.length ? input.stubs : goal.reproHint ? [goal.reproHint] : [];
  if (!stubs.length)
    throw new UserError(
      `${goal.id} has no --repro-hint: name the module the reproduction test imports with --stub <path> (repeatable)`,
    );
  return parseExecutionProposal({
    id: `EXEC-${goal.id.replace(/^GOAL-/, '')}`,
    version: input.version,
    goalId: goal.id,
    goalVersion: goal.version,
    mode: 'solo-direct',
    approach:
      'The Tester adds a test that reproduces the bug and is red on the code as it is; it is locked. The Worker then fixes the code until that test and the rest are green',
    rationale: 'A bug is one small change: one Tester commit with the test, one Worker commit with the fix',
    risks: ['The test passes for another reason than the bug, or the fix reaches past the bug'],
    baseCommit: input.baseCommit,
    sourceSha256: goal.source.sha256,
    ...(input.paths
      ? { paths: input.paths }
      : root === undefined
        ? {}
        : { paths: [root === '.' ? '**' : `${root}/**`] }),
    stubPaths: stubs,
    acceptanceMapping: goal.acceptance.map(item => ({
      acceptanceId: item.id,
      verification: 'locked reproduction test: red on the base commit, green on the delivery',
    })),
    verificationStrategy: 'the locked reproduction test, then the Goal check and the layers of the stage',
  });
}

/** What the Human's inbox says about a Goal in draft: a bug or a maintenance Goal is approved in one go, any other Goal through gate A. */
export const draftGateDetail = (goal: GoalSpec): string =>
  goal.kind === 'bugfix'
    ? `gates A and B in one go: apos bug approve ${goal.id}`
    : goal.kind === 'maintenance'
      ? `gates A and B in one go: apos maintenance approve ${goal.id}`
      : 'gate A: approve the Goal and its appetite';
