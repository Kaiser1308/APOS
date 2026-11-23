import { parseExecutionProposal, parseGoalSpec, type ExecutionProposal, type GoalSpec } from './contracts.js';
import { UserError } from './errors.js';
import { sourceDigest } from './gate.js';
import { rootedGlobs } from './glob.js';
import type { LayerSpec, ProjectSetup } from './project-setup.js';
import type { LayerId } from './layers.js';
import type { CheckResult } from './gate.js';

/** What `maintenance approve` asks the Human to approve unless a flag says otherwise: a small change, an hour, three red gates. */
export const MAINT_APPETITE = { size: 'S', maxWallMinutes: 60, maxAttempts: 3, overrun: 'ask' } as const;
/** The `via` that `maintenance approve` writes on its three events, and what the assurance table reads back. */
export const MAINT_APPROVE_VIA = 'maintenance approve';
/** The layers a maintenance Goal runs at the submit stage on every part it touches, whatever the floor says. */
export const MAINT_LAYERS: readonly LayerId[] = ['L1', 'L2', 'L3', 'L5'];

export type MaintenanceRequest = {
  description: string;
  /** What `--security` named: the fingerprints of the base findings the delivery must no longer show. */
  security: string[];
  paths: string[];
  part?: string;
  fromPr?: { number: number; remote: string; sha: string };
};

/** The next free `GOAL-MAINT-<n>`; ordinary Goal ids are never touched. */
export function nextMaintenanceId(existing: string[]): string {
  const used = existing.map(id => /^GOAL-MAINT-(\d+)$/.exec(id)?.[1]).filter((n): n is string => n !== undefined);
  return `GOAL-MAINT-${String(Math.max(0, ...used.map(Number)) + 1).padStart(3, '0')}`;
}

/** The verbatim source of a maintenance Goal: the description and the flags, in the order a reader needs them. */
export function maintenanceSourceText(request: MaintenanceRequest): string {
  const lines = ['# Bảo trì', '', request.description, ''];
  if (request.security.length) lines.push(`- Vá bảo mật (finding phải biến mất): ${request.security.join(', ')}`);
  if (request.paths.length) lines.push(`- Được sửa thêm: ${request.paths.join(', ')}`);
  if (request.part) lines.push(`- Phần: ${request.part}`);
  if (request.fromPr) lines.push(`- Từ PR #${request.fromPr.number} (${request.fromPr.remote}) ${request.fromPr.sha}`);
  return `${lines.join('\n')}\n`;
}

/** The sarif tools of L5 that run without a flag, with the part each belongs to: what a security Goal needs. */
export function scanTools(setup: ProjectSetup, part?: string): { part: string; tool: LayerSpec; key: string }[] {
  return Object.entries(setup.parts)
    .filter(([name]) => part === undefined || name === part)
    .flatMap(([name, where]) =>
      (where.layers.L5 ?? [])
        .filter(tool => tool.format === 'sarif' && (tool.when ?? 'always') === 'always')
        .map(tool => ({ part: name, tool, key: `${name}.L5.${tool.id}` })),
    );
}

/** The manifest and lockfile globs of a part, relative to the repo; empty when the setup says none. */
export const manifestGlobs = (setup: ProjectSetup, part: string): string[] => {
  const where = setup.parts[part];
  return where ? rootedGlobs(where.root, where.manifests ?? []) : [];
};

/** What the gate lets a maintenance Goal change: the manifests of its part and the paths the Human approved. */
export function maintenanceScope(setup: ProjectSetup, goal: GoalSpec): string[] {
  const parts = goal.part ? [goal.part] : Object.keys(setup.parts);
  return [...parts.flatMap(part => manifestGlobs(setup, part)), ...(goal.paths ?? [])];
}

/** The Goal of a maintenance request: one requirement, no criterion, no check; the gate measures it against the base. */
export function maintenanceGoalSpec(input: {
  id: string;
  request: MaintenanceRequest;
  baseline?: GoalSpec['baseline'];
  now: string;
}): GoalSpec {
  const { id, request } = input;
  return parseGoalSpec({
    id,
    version: 1,
    kind: 'maintenance',
    ...(request.part ? { part: request.part } : {}),
    ...(request.paths.length ? { paths: request.paths } : {}),
    ...(request.security.length ? { security: request.security } : {}),
    ...(input.baseline ? { baseline: input.baseline } : {}),
    ...(request.fromPr ? { fromPr: request.fromPr } : {}),
    outcome: request.description,
    source: {
      path: 'maintenance-request',
      sha256: sourceDigest(maintenanceSourceText(request)),
      capturedAt: input.now,
      origin: 'human',
    },
    requirements: [
      { id: 'R-1', sourceSpan: 'maintenance request', text: request.description, disposition: 'acceptance' },
    ],
    scope: [`manifests and lockfiles of ${request.part ? `part ${request.part}` : 'the project'}`],
  });
}

/** The Solo plan of a maintenance Goal: the Worker changes the manifests (and the declared paths) and the gate holds it to the base. No Tester. */
export function maintenanceProposal(input: {
  goal: GoalSpec;
  version: number;
  baseCommit: string;
  setup: ProjectSetup;
}): ExecutionProposal {
  const { goal, setup } = input;
  const parts = goal.part ? [goal.part] : Object.keys(setup.parts);
  if (!parts.some(part => manifestGlobs(setup, part).length))
    throw new UserError(
      `the setup lists no manifests for ${parts.length === 1 ? `part "${parts[0]}"` : 'any part'}: add \`manifests\` to it (docs/setup.md), approve the setup again, then plan`,
    );
  return parseExecutionProposal({
    id: `EXEC-${goal.id.replace(/^GOAL-/, '')}`,
    version: input.version,
    goalId: goal.id,
    goalVersion: goal.version,
    mode: 'solo-direct',
    approach:
      'The Worker changes the manifests and lockfiles (and the paths the Goal names) and nothing else. The gate runs the tests and the scan on the base and on the delivery: no new failure, no new finding, and the named findings gone',
    rationale: 'A dependency change has no new behaviour to specify: one commit, held to what the base already does',
    risks: ['The upgrade changes behaviour the existing tests do not cover'],
    baseCommit: input.baseCommit,
    sourceSha256: goal.source.sha256,
    paths: maintenanceScope(setup, goal),
    acceptanceMapping: [],
    verificationStrategy:
      'the layers L1, L2, L3 and the scan on the base and on the delivery, and the scope of the change',
  });
}

export const SECURITY_CHECK = 'APOS-SECURITY';

const checkResult = (status: CheckResult['status'], reason: string): CheckResult => ({
  checkId: SECURITY_CHECK,
  status,
  reason,
  base: [],
  delivery: [],
  newFailures: [],
});

/**
 * The finding(s) a security Goal names must be on the base and gone on the delivery. Each scan check of the gate says
 * which base findings it saw gone (`fixed`) or still there (`remaining`); a named finding no scan judged is not proved.
 */
export function securityCheck(security: string[], checks: CheckResult[]): CheckResult {
  const scans = checks.flatMap(check => (check.scan ? [check.scan] : []));
  const fixed = new Set(scans.flatMap(scan => scan.fixed));
  const remaining = new Set(scans.flatMap(scan => scan.remaining));
  const still = security.filter(print => remaining.has(print));
  const unjudged = security.filter(print => !fixed.has(print) && !remaining.has(print));
  if (still.length) return checkResult('fail', `finding vẫn còn trên commit giao: ${still.join(', ')}`);
  // A scan that could not run, or ran twice with different answers, has proved nothing about the finding: not a failure of the patch.
  if (unjudged.length && checks.some(check => check.status === 'unverifiable'))
    return checkResult(
      'unverifiable',
      `chưa xét được finding ${unjudged.join(', ')}: một lớp của lần giao này không cho kết quả chắc chắn`,
    );
  if (unjudged.length)
    return checkResult(
      'fail',
      `không tái hiện được finding trên base, hoặc không công cụ quét nào của lần giao này đã xét: ${unjudged.join(', ')}`,
    );
  return checkResult('pass', `finding ${security.join(', ')} có trên base, không còn trên commit giao`);
}

/**
 * Why a maintenance Goal cannot be approved, before anything is written: it needs the setup (the manifests and the scan come
 * from it), and a security Goal needs a scan tool and a base scan that shows each finding it names.
 */
export function maintenanceApprovalProblems(goal: GoalSpec, setup: ProjectSetup | undefined): string[] {
  if (goal.kind !== 'maintenance') return [];
  if (!setup) return ['a maintenance Goal needs an approved setup: the manifests and the scan come from it'];
  const named = goal.security ?? [];
  if (!named.length) return [];
  if (!scanTools(setup, goal.part).length)
    return ['the setup has no scan tool (a sarif tool in L5): a security Goal cannot show the finding gone'];
  const seen = new Set((goal.baseline?.scans ?? []).flatMap(scan => scan.findings.map(item => item.fingerprint)));
  return named.filter(print => !seen.has(print)).map(print => `không tái hiện được finding trên base: ${print}`);
}
