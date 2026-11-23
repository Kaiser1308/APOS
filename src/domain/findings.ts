import { createHash } from 'node:crypto';
import type { Finding } from './results/types.js';

const RANK: Record<Finding['level'], number> = { note: 0, warning: 1, error: 2 };
/** Whether a finding of `level` is at the blocking level or above. */
export const blocks = (level: Finding['level'], failOn: Finding['level']): boolean => RANK[level] >= RANK[failOn];

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const normalPath = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//, '');

/**
 * The identity of a finding that survives edits which only move lines: the SARIF `partialFingerprints` when the tool
 * writes them, else the rule, the path and a hash of the message. The line number is never part of it.
 */
export function findingFingerprint(input: {
  ruleId: string;
  file?: string;
  message?: string;
  partial?: Record<string, string>;
}): string {
  const keys = Object.keys(input.partial ?? {}).sort();
  if (keys.length) return `fp:${keys.map(key => `${key}=${input.partial![key]}`).join(',')}`;
  const body = [input.ruleId, input.file === undefined ? '' : normalPath(input.file), sha(input.message ?? '')].join(
    '\n',
  );
  return `h:${sha(body).slice(0, 16)}`;
}

export type FindingDiff = {
  baseTotal: number;
  /** Findings of the delivery the base did not have, at the blocking level or above. */
  newBlocking: Finding[];
  /** Findings of the delivery the base did not have, below the blocking level. */
  newLower: number;
  /** Fingerprints the base had and the delivery no longer has. */
  fixed: string[];
};

/** What the delivery's scan shows that the base's did not, by fingerprint. A finding that moved to another line is not new. */
export function diffFindings(base: Finding[], head: Finding[], failOn: Finding['level']): FindingDiff {
  const before = new Set(base.map(item => item.fingerprint));
  const after = new Set(head.map(item => item.fingerprint));
  const seen = new Set<string>();
  const fresh = head.filter(item => {
    if (before.has(item.fingerprint) || seen.has(item.fingerprint)) return false;
    seen.add(item.fingerprint);
    return true;
  });
  return {
    baseTotal: before.size,
    newBlocking: fresh.filter(item => blocks(item.level, failOn)),
    newLower: fresh.filter(item => !blocks(item.level, failOn)).length,
    fixed: [...before].filter(print => !after.has(print)).sort(),
  };
}

export type SecurityMatch = { ok: true; finding: Finding } | { ok: false; reason: string };

const describe = (item: Finding): string =>
  `${item.fingerprint} ${item.ruleId}${item.file ? ` ${item.file}` : ''} (${item.level})`;

/**
 * Which finding of the base a `--security <finding>` names: its fingerprint, or a `ruleId` that exactly one finding has.
 * A finding the base does not show cannot be fixed by the delivery, so it is refused; several are listed.
 */
export function matchSecurity(baseFindings: Finding[], token: string): SecurityMatch {
  const unique = [...new Map(baseFindings.map(item => [item.fingerprint, item])).values()];
  const byPrint = unique.filter(item => item.fingerprint === token);
  const hits = byPrint.length ? byPrint : unique.filter(item => item.ruleId === token);
  if (hits.length === 1) return { ok: true, finding: hits[0]! };
  if (!hits.length)
    return { ok: false, reason: `không tái hiện được finding trên base: "${token}" không có trong kết quả quét` };
  return {
    ok: false,
    reason: `"${token}" khớp ${hits.length} finding trên base, nêu dấu vân tay của một finding:\n${hits.map(item => `  ${describe(item)}`).join('\n')}`,
  };
}
