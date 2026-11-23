import type { CheckResult, GateReport } from './gate.js';
import type { LayerId } from './layers.js';
import { planLayers, type LayerRun, type LayerWhy, type PlanInput, type Stage } from './layer-plan.js';
import { reviewOverrideBy } from './review-tests.js';
import { proofDemands } from './proof-tools.js';
import type { ProjectSetup } from './project-setup.js';
import { acceptanceProof } from './test-plan.js';
import { goalFlagsOf, MUTATION_FLAG } from './goal-flags.js';
import type { GoalState } from './transitions.js';

export type LayerStatus = 'pass' | 'fail' | 'unverifiable' | 'reduced' | 'not-run';
export type LayerRow = {
  stage: Stage;
  /** A package id at `submit`, `goal` at the later stages. */
  scope: string;
  part: string;
  layer: LayerId;
  tool: string;
  why: LayerWhy;
  status: LayerStatus;
  /** What the tool measured or found: `p95_ms 160`, `2 finding(s) dưới mức chặn`. */
  note?: string;
};
export type AssuranceReport = {
  goalId: string;
  /** Absent when the Goal is not pinned to a setup: every guarantee that depends on one is off. */
  setup?: { version: number; parts: Record<string, string> };
  criteria: { total: number; machine: number; manual: number; byProof: Record<string, number> };
  /** Inventory and scope run with the package gate of a Goal pinned to a setup. */
  guards: boolean;
  lockedTests: {
    byLayer: Record<string, number>;
    revisions: number;
    autoRelocked: number;
    approvedWeakenings: number;
  };
  layers: LayerRow[];
  /** Present when a review blocked a delivery with a test: how many times, how many tests it locked, and the blocks a Lead overrode. */
  reviews?: { blocks: number; lockedTests: number; overridden: { ids: string[]; by: string }[] };
  /** `by` is `human`, `on-behalf:<where they agreed>` or `agent:<name>`. */
  exceptions: { kind: string; ref: string; by: string; reason: string }[];
  /** What is off, and why. */
  off: string[];
  /** Tools whose only evidence is an exit code: no test ids, no counts. */
  exitOnly: string[];
};

const STATUS_OF: Record<string, LayerStatus> = { pass: 'pass', fail: 'fail', unverifiable: 'unverifiable' };

function noteOf(check: CheckResult): string | undefined {
  if (check.findings)
    return check.findings.blocking
      ? `${check.findings.blocking} finding chặn, ${check.findings.lower} dưới mức chặn`
      : check.findings.lower
        ? `${check.findings.lower} finding dưới mức chặn`
        : undefined;
  // A metric read from a deep path (`files.0.groups.0.benchmarks.0.p99`) is labelled by its last segment; the check keeps the path.
  return check.metric
    ? `${check.metric.name.split('.').at(-1)} ${Number(check.metric.value.toPrecision(4))}`
    : undefined;
}

function rowsOf(stage: Stage, scope: string, gate: GateReport): LayerRow[] {
  return (gate.layers?.runs ?? []).map(run => {
    const key = `${run.part}.${run.layer}.${run.tool}`;
    // A metric tool with several benchmark criteria has one check per metric (`<key>:<metric>`): the row is the worst of them.
    const checks = gate.checks.filter(item => item.checkId === key || item.checkId.startsWith(`${key}:`));
    const statuses = checks.map(item => STATUS_OF[item.status] ?? 'unverifiable');
    const status: LayerStatus = run.reduced
      ? 'reduced'
      : !checks.length
        ? 'not-run'
        : statuses.includes('fail')
          ? 'fail'
          : statuses.every(item => item === 'pass')
            ? 'pass'
            : 'unverifiable';
    const note = checks
      .map(noteOf)
      .filter((item): item is string => item !== undefined)
      .join('; ');
    return {
      stage,
      scope,
      part: run.part,
      layer: run.layer,
      tool: run.tool,
      why: run.why,
      status,
      ...(note ? { note } : {}),
    };
  });
}

/** The gates the table reads: the latest of each package, the integration gate of a Multi-WP Goal, the close gate. */
function gatesOf(state: GoalState): { stage: Stage; scope: string; gate: GateReport }[] {
  const out: { stage: Stage; scope: string; gate: GateReport }[] = [];
  for (const [id, item] of Object.entries(state.packages ?? {}))
    if (item.gate?.layers) out.push({ stage: 'submit', scope: id, gate: item.gate });
  if (state.proposal?.mode === 'multi-wp' && state.gate?.layers?.stage === 'integrate')
    out.push({ stage: 'integrate', scope: 'goal', gate: state.gate });
  if (state.closeGate?.layers) out.push({ stage: 'close', scope: 'goal', gate: state.closeGate });
  return out;
}

function who(entry: NonNullable<GoalState['exceptions']>[number]): string {
  if (entry.by !== 'human') return entry.by;
  return entry.confirmation?.by === 'on-behalf' ? `on-behalf:${entry.confirmation.onBehalf ?? '?'}` : 'human';
}

/**
 * What a Goal's guarantees rest on, derived from the log alone (plus the pinned setup when the caller has it, which adds
 * the layers the close stage will run and the stacks). Nothing here decides anything: it only says what the gates did.
 */
export function buildAssuranceReport(state: GoalState, setup?: ProjectSetup): AssuranceReport {
  const goalId = state.spec.id;
  const proofs = state.spec.acceptance.map(item => acceptanceProof(item));
  const byProof: Record<string, number> = {};
  for (const proof of proofs) byProof[proof] = (byProof[proof] ?? 0) + 1;
  const manual = proofs.filter(proof => proof === 'manual').length;

  const byLayer: Record<string, number> = {};
  for (const entry of state.testLock?.map ?? [])
    byLayer[entry.layer] = (byLayer[entry.layer] ?? 0) + entry.testIds.length;
  const exceptions = (state.exceptions ?? []).map(entry => ({
    kind: entry.kind,
    ref: entry.ref,
    by: who(entry),
    reason: entry.reason,
  }));
  const approvedWeakenings = exceptions.filter(entry => entry.kind === 'tests-weakened').length;
  const revisions = state.testRevisions ?? 0;

  const blocks = state.reviewTests ?? [];
  const reviews = blocks.length
    ? {
        blocks: blocks.length,
        lockedTests: blocks.reduce((sum, block) => sum + block.tests.length, 0),
        overridden: blocks.flatMap(block => {
          const by = reviewOverrideBy(state, block);
          return by ? [{ ids: block.blocking.map(test => test.id), by }] : [];
        }),
      }
    : undefined;

  const gates = gatesOf(state);
  const layers = gates.flatMap(({ stage, scope, gate }) => rowsOf(stage, scope, gate));
  const off = new Set<string>();
  for (const { gate } of gates) for (const note of gate.layers?.skipped ?? []) off.add(note);
  const exitOnly = [
    ...new Set(
      gates.flatMap(({ gate }) =>
        (gate.layers?.runs ?? [])
          .filter(run => run.format === 'exit' && !run.reduced)
          .map(run => `${run.part}.${run.layer}.${run.tool}`),
      ),
    ),
  ];

  if (setup && !state.closeGate && state.status !== 'closed' && state.status !== 'stopped') {
    const input: PlanInput = {
      setup,
      stage: 'close',
      changed: state.gate?.changedFiles ?? [],
      goalFlags: goalFlagsOf(state),
      reductions: [],
      requiredTools: proofDemands(state.spec).map(item => item.tool),
    };
    const planned: LayerRun[] = planLayers(input);
    for (const run of planned)
      layers.push({
        stage: 'close',
        scope: 'goal',
        part: run.part,
        layer: run.layer,
        tool: run.tool.id,
        why: run.why,
        status: 'not-run',
      });
  }

  const unchecked = state.testLock?.unchecked ?? [];
  for (const part of unchecked)
    off.add(
      `test chỉ gọi qua cửa: ${part}${setup?.parts[part]?.stack ? ` (${setup.parts[part]!.stack})` : ''} chưa kiểm (danh mục chưa có luật)`,
    );
  const hasMutationTool = Object.values(setup?.parts ?? {}).some(part =>
    Object.values(part.layers).some(tools => tools?.some(tool => tool.when === `flag:${MUTATION_FLAG}`)),
  );
  if (hasMutationTool && !goalFlagsOf(state).includes(MUTATION_FLAG)) off.add('mutation tắt (Goal không gắn cờ)');
  if (state.setupVersion === undefined) off.add('mọi bảo đảm theo setup tắt: Goal không có setup');
  else if (!state.testLock)
    off.add('khoá test: tắt (setup không khai tests.paths, hoặc Goal không có tiêu chí cần test)');

  return {
    goalId,
    ...(state.setupVersion === undefined
      ? {}
      : {
          setup: {
            version: state.setupVersion,
            parts: Object.fromEntries(
              Object.entries(setup?.parts ?? {}).map(([name, part]) => [name, part.stack ?? '?']),
            ),
          },
        }),
    criteria: { total: proofs.length, machine: proofs.length - manual, manual, byProof },
    guards: state.setupVersion !== undefined,
    lockedTests: {
      byLayer,
      revisions,
      autoRelocked: Math.max(0, revisions - approvedWeakenings),
      approvedWeakenings,
    },
    layers,
    ...(reviews ? { reviews } : {}),
    exceptions,
    off: [...off],
    exitOnly,
  };
}

const MARK: Record<LayerStatus, string> = {
  pass: '✓',
  fail: '✗',
  unverifiable: '?',
  reduced: 'bớt',
  'not-run': 'chưa chạy',
};
const WHY: Record<LayerWhy, string> = {
  floor: '',
  lead: ' (Lead thêm)',
  trigger: ' (kích hoạt theo file)',
  'goal-flag': ' (cờ của Goal)',
  proof: ' (tiêu chí)',
};
const STAGE_NAME: Record<Stage, string> = { submit: 'submit', integrate: 'ghép', close: 'đóng' };
const label = (text: string) => `  ${text.padEnd(19)}`;

/** The text of spec 6.9: what the machine proved, what the Human confirmed by hand, who approved on whose behalf, what is off. */
export function renderAssuranceText(report: AssuranceReport): string {
  const lines: string[] = [];
  const parts = report.setup ? Object.entries(report.setup.parts).map(([name, stack]) => `${name}: ${stack}`) : [];
  lines.push(
    `${report.goalId}  ${report.setup ? `setup v${report.setup.version}${parts.length ? `  (${parts.join(', ')})` : ''}` : 'không có setup'}`,
  );
  const { criteria } = report;
  lines.push(
    `${label('Tiêu chí')}${criteria.total}   máy chứng minh ${criteria.machine} · anh xác nhận tay ${criteria.manual}`,
  );
  const locked = Object.entries(report.lockedTests.byLayer).map(([layer, count]) => `${layer} ${count}`);
  const { revisions, autoRelocked, approvedWeakenings } = report.lockedTests;
  lines.push(
    `${label('Test đã khoá')}${locked.length ? locked.join(' · ') : 'không có'}${
      revisions
        ? `      sửa sau khoá: ${revisions} (máy tự khoá lại ${autoRelocked}, duyệt bớt assert ${approvedWeakenings})`
        : ''
    }`,
  );
  lines.push(`${label('Kiểm kê / phạm vi')}${report.guards ? 'bật' : 'tắt'}`);
  const stages: Stage[] = ['submit', 'integrate', 'close'];
  for (const stage of stages) {
    const scopes = [...new Set(report.layers.filter(row => row.stage === stage).map(row => row.scope))];
    for (const scope of scopes) {
      const rows = report.layers.filter(row => row.stage === stage && row.scope === scope);
      const shown = rows.map(
        row =>
          `${row.layer} ${row.part === 'system' ? 'system ' : ''}${row.tool}${WHY[row.why]} ${MARK[row.status]}${row.note ? ` (${row.note})` : ''}`,
      );
      lines.push(
        `${label(`Lớp khâu ${STAGE_NAME[stage]}`)}${stage === 'submit' ? `${scope}: ` : ''}${shown.join(' · ')}`,
      );
    }
  }
  if (report.reviews)
    lines.push(
      `${label('Review chặn')}${report.reviews.blocks} lần bằng test đỏ, ${report.reviews.lockedTests} test đã khoá vào lần giao sau${report.reviews.overridden.map(item => `; review bị bỏ qua: ${item.ids.join(', ')}, duyệt bởi ${item.by}`).join('')}`,
    );
  const agent = report.exceptions.filter(entry => entry.by.startsWith('agent:'));
  if (report.exceptions.length)
    lines.push(
      `${label('Ngoại lệ')}${report.exceptions.map(entry => `${entry.kind} ${entry.ref} (${entry.by}): ${entry.reason}`).join('; ')}`,
    );
  lines.push(
    `${label('Agent duyệt thay')}${agent.length} chỗ${agent.length ? `: ${agent.map(entry => `${entry.kind} ${entry.ref} (${entry.by})`).join('; ')}` : ''}`,
  );
  if (report.exitOnly.length) lines.push(`${label('Chỉ có mã thoát')}${report.exitOnly.join(', ')}`);
  for (const note of report.off) lines.push(`${label('Tắt / chưa kiểm')}${note}`);
  return lines.join('\n');
}
