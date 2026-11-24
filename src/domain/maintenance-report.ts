import { SCOPE_CHECK } from './assurance.js';
import { SECURITY_CHECK, scanTools } from './maintenance.js';
import type { ProjectSetup } from './project-setup.js';
import type { GoalState } from './transitions.js';

/** What the assurance table says about a maintenance Goal, read from the log: the latest gate of its one package. */
export type MaintenanceEvidence = {
  /** False until a gate has judged a delivery. */
  judged: boolean;
  /** `pass` when only manifests and the declared paths changed, `fail` with the names when not. */
  scope?: { ok: boolean; reason: string };
  /** Tests already failing on the base (not counted as new), and tests that fail now and did not then. */
  baseFailing: number;
  newFailures: number;
  /** `no-tool` when the setup has no scan to run; otherwise what the scans added. */
  scan: 'no-tool' | { newBlocking: number; newLower: number };
  security?: { named: string[]; proven: boolean; base?: string; commit?: string };
  fromPr?: { number: number; sha: string };
};

export function maintenanceEvidence(
  state: GoalState,
  setup: ProjectSetup | undefined,
): MaintenanceEvidence | undefined {
  if (state.spec.kind !== 'maintenance') return undefined;
  const gate = state.gate;
  const checks = gate?.checks ?? [];
  const scope = checks.find(check => check.checkId === SCOPE_CHECK);
  const scans = checks.flatMap(check => (check.scan ? [check.scan] : []));
  const security = state.spec.security;
  // A fingerprint says little to a reader: the rule the base scan gave the finding goes beside it.
  const ruleOf = new Map(
    (state.spec.baseline?.scans ?? []).flatMap(scan => scan.findings.map(item => [item.fingerprint, item.ruleId])),
  );
  const proven = checks.find(check => check.checkId === SECURITY_CHECK)?.status === 'pass';
  return {
    judged: Boolean(gate),
    ...(scope ? { scope: { ok: scope.status !== 'fail', reason: scope.reason } } : {}),
    baseFailing: checks.reduce((sum, check) => sum + (check.baseFailing ?? 0), 0),
    newFailures: checks.reduce((sum, check) => sum + check.newFailures.length, 0),
    scan:
      setup && !scanTools(setup).length && !scans.length
        ? 'no-tool'
        : {
            newBlocking: scans.reduce((sum, scan) => sum + scan.newBlocking, 0),
            newLower: scans.reduce((sum, scan) => sum + scan.newLower, 0),
          },
    ...(security?.length
      ? {
          security: {
            named: security.map(print => (ruleOf.has(print) ? `${ruleOf.get(print)} (${print})` : print)),
            proven,
            ...(proven && gate ? { base: gate.baseCommit.slice(0, 7), commit: gate.deliveryCommit.slice(0, 7) } : {}),
          },
        }
      : {}),
    ...(state.spec.fromPr
      ? { fromPr: { number: state.spec.fromPr.number, sha: state.spec.fromPr.sha.slice(0, 7) } }
      : {}),
  };
}

/** The lines of the table for a maintenance Goal, in Vietnamese like the rest; `label` pads the left column. */
export function maintenanceLines(evidence: MaintenanceEvidence, label: (text: string) => string): string[] {
  const lines: string[] = [];
  if (!evidence.judged) lines.push(`${label('Bảo trì')}chưa có gate nào xét bản giao`);
  else if (evidence.scope && !evidence.scope.ok)
    lines.push(`${label('Bảo trì')}chạm ngoài manifest/lockfile và paths đã khai: ${evidence.scope.reason}`);
  else
    lines.push(
      `${label('Bảo trì')}chỉ chạm manifest/lockfile (+ paths); lỗi có sẵn trên base: ${evidence.baseFailing}; lỗi mới: ${evidence.newFailures}`,
    );
  if (evidence.scan === 'no-tool') lines.push(`${label('Quét')}setup không có công cụ`);
  else if (evidence.judged)
    lines.push(`${label('Quét')}finding mới ${evidence.scan.newBlocking} (dưới mức chặn: ${evidence.scan.newLower})`);
  if (evidence.security)
    lines.push(
      `${label('Vá bảo mật')}${
        evidence.security.proven
          ? `finding ${evidence.security.named.join(', ')} có trên ${evidence.security.base}, không còn trên ${evidence.security.commit}`
          : `finding ${evidence.security.named.join(', ')}: chưa chứng minh biến mất`
      }`,
    );
  if (evidence.fromPr) lines.push(`${label('Nguồn')}từ PR #${evidence.fromPr.number} ${evidence.fromPr.sha}`);
  return lines;
}
