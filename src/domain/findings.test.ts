import { describe, expect, it } from 'vitest';
import { diffFindings, findingFingerprint, matchSecurity } from './findings.js';
import type { Finding } from './results/types.js';

const finding = (ruleId: string, level: Finding['level'], file: string, message: string, line = 1): Finding => ({
  ruleId,
  level,
  file,
  line,
  fingerprint: findingFingerprint({ ruleId, file, message }),
});

describe('findingFingerprint', () => {
  it('ignores the line and the path separator style, not the rule, the path or the message', () => {
    const a = findingFingerprint({ ruleId: 'r', file: 'src\\a.ts', message: 'm' });
    expect(a).toBe(findingFingerprint({ ruleId: 'r', file: './src/a.ts', message: 'm' }));
    expect(a).not.toBe(findingFingerprint({ ruleId: 'r2', file: 'src/a.ts', message: 'm' }));
    expect(a).not.toBe(findingFingerprint({ ruleId: 'r', file: 'src/b.ts', message: 'm' }));
    expect(a).not.toBe(findingFingerprint({ ruleId: 'r', file: 'src/a.ts', message: 'other' }));
  });
  it('prefers the SARIF partialFingerprints, in key order', () => {
    const one = findingFingerprint({ ruleId: 'r', file: 'a.js', partial: { b: '2', a: '1' } });
    expect(one).toBe('fp:r@a.js:a=1,b=2');
    expect(one).toBe(findingFingerprint({ ruleId: 'r', file: './a.js', message: 'y', partial: { a: '1', b: '2' } }));
  });
  it('does not let two rules, or two files, share a partial fingerprint', () => {
    const partial = { primaryLocationLineHash: 'same' };
    const base = findingFingerprint({ ruleId: 'r', file: 'a.js', partial });
    expect(base).not.toBe(findingFingerprint({ ruleId: 'other', file: 'a.js', partial }));
    expect(base).not.toBe(findingFingerprint({ ruleId: 'r', file: 'b.js', partial }));
  });
});

describe('diffFindings', () => {
  const old = finding('eval', 'error', 'a.js', 'eval is bad', 3);
  it('a finding that only moved to another line is not new', () => {
    const moved = { ...old, line: 40 };
    expect(diffFindings([old], [moved], 'error')).toEqual({ baseTotal: 1, newBlocking: [], newLower: 0, fixed: [] });
  });
  it('splits the new findings at the blocking level and reports the fixed ones', () => {
    const bad = finding('sql', 'error', 'b.js', 'injection');
    const mild = finding('style', 'warning', 'b.js', 'meh');
    const diff = diffFindings([old], [bad, mild], 'error');
    expect(diff.newBlocking).toEqual([bad]);
    expect(diff.newLower).toBe(1);
    expect(diff.fixed).toEqual([old.fingerprint]);
  });
});

describe('matchSecurity', () => {
  const a = finding('eval', 'error', 'a.js', 'one');
  const b = finding('eval', 'error', 'b.js', 'two');
  const c = finding('xss', 'warning', 'c.js', 'three');
  it('takes a fingerprint, or a ruleId that exactly one finding has', () => {
    expect(matchSecurity([a, b, c], a.fingerprint)).toEqual({ ok: true, finding: a });
    expect(matchSecurity([a, b, c], 'xss')).toEqual({ ok: true, finding: c });
  });
  it('refuses a finding the base does not show', () => {
    const got = matchSecurity([a], 'xss');
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.reason).toContain('không tái hiện được finding trên base');
  });
  it('refuses a ruleId several findings share and lists them', () => {
    const got = matchSecurity([a, b], 'eval');
    expect(got.ok === false && got.reason).toContain(a.fingerprint);
    expect(got.ok === false && got.reason).toContain(b.fingerprint);
  });
});
