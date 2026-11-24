import { redNote, short, type HotfixLayerResult, type HotfixStatus, hotfixStatus } from './hotfix.js';
import type { GoalState } from './transitions.js';

/** What the assurance table says about a hotfix Goal, derived from the log alone. */
export type HotfixEvidence = {
  commit: string;
  before: string;
  /** `Human` or `on-behalf:<where they agreed>`. */
  by: string;
  acceptedAt: string;
  dueAt: string;
  /** Only with a clock: waiting or overdue. Without one the table says the deadline and no more. */
  status?: HotfixStatus;
  /** The locked test, with the delivery it went green on, once the evidence is whole. */
  proof?: { test: string; delivery: string };
  /** What L0 and L1 said on the hotfix commit, or why they did not run. */
  gate: string;
  /** `hotfix đỏ ở L1` when a layer was red there, else empty. */
  red: string;
  /** The Goal was stopped: the hotfix stays without evidence for good. */
  abandoned: boolean;
};

const layerText = (layer: HotfixLayerResult) =>
  `${layer.part}.${layer.layer} ${layer.tool} ${layer.status === 'pass' ? '✓' : layer.status === 'fail' ? '✗' : '?'}`;

export function hotfixEvidence(
  state: GoalState,
  bug: { reproduced: boolean; test?: string; greenOn?: string } | undefined,
  now?: string,
): HotfixEvidence | undefined {
  const item = state.hotfix;
  if (!item) return undefined;
  const status = now ? hotfixStatus(state, now) : undefined;
  // A stopped Goal proves nothing: whatever its tests did, the hotfix stays without evidence.
  const proof = bug?.reproduced && state.status !== 'stopped' ? { test: bug.test!, delivery: bug.greenOn! } : undefined;
  const ran = (item.layers ?? []).map(layerText).join(' · ');
  return {
    commit: item.commit,
    before: item.before,
    by: item.by === 'on-behalf' ? `on-behalf:${item.onBehalf ?? '?'}` : 'Human',
    acceptedAt: item.acceptedAt,
    dueAt: item.dueAt,
    ...(status ? { status } : {}),
    ...(proof ? { proof } : {}),
    gate: ran || item.gateNote || 'L0 và L1 chưa chạy trên hotfix',
    red: redNote(item),
    abandoned: state.status === 'stopped',
  };
}

export function hotfixLines(evidence: HotfixEvidence, label: (text: string) => string): string[] {
  const head = `hotfix ${short(evidence.commit)} chấp nhận khẩn cấp bởi ${evidence.by} lúc ${evidence.acceptedAt}`;
  const tail = evidence.proof
    ? `lỗi được tái hiện bằng test ${evidence.proof.test}: đỏ trên ${short(evidence.before)}, xanh trên ${short(evidence.commit)} (bản giao ${evidence.proof.delivery} chứa hotfix)`
    : evidence.abandoned
      ? `chưa có bằng chứng: Goal đã bị huỷ, hotfix này mãi chưa có bằng chứng (hạn ${evidence.dueAt})`
      : `chưa có bằng chứng, hạn ${evidence.dueAt}${evidence.status === 'overdue' ? ' (QUÁ HẠN)' : ''}`;
  return [
    `${label('Hotfix')}${head}; ${tail}`,
    `${label('Gate trên hotfix')}${evidence.gate}${evidence.red ? ` (${evidence.red})` : ''} (chỉ ghi, không chặn)`,
  ];
}
