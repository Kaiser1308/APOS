import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergeReports, readReport, type ParsedReport } from './index.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('sarif', () => {
  it('reads eslint findings, resolving the rule from ruleIndex', () => {
    expect(readReport('sarif', fixture('eslint.sarif.json'))).toEqual({
      kind: 'findings',
      findings: [
        { ruleId: 'no-unused-vars', level: 'error', file: 'src/a.ts', line: 3 },
        { ruleId: 'eqeqeq', level: 'warning', file: 'src/b.ts', line: 9 },
      ],
    });
  });
  it('reads semgrep findings: missing level is warning, missing location is omitted', () => {
    expect(readReport('sarif', fixture('semgrep.sarif.json'))).toEqual({
      kind: 'findings',
      findings: [
        { ruleId: 'javascript.lang.security.audit.eval', level: 'warning', file: 'web/app.js', line: 12 },
        { ruleId: 'generic.secrets.token', level: 'note' },
      ],
    });
  });
  it('a run with an empty results array is a clean report', () => {
    expect(readReport('sarif', fixture('clean.sarif.json'))).toEqual({ kind: 'findings', findings: [] });
  });
  it('is unreadable when broken, empty, without runs, or a run has no results array', () => {
    for (const content of [
      fixture('broken.sarif.txt'),
      '',
      '   \n',
      '{}',
      '{"runs":[]}',
      '{"runs":[{"tool":{"driver":{"name":"x"}}}]}',
    ])
      expect(readReport('sarif', content).kind).toBe('unreadable');
  });
});

describe('metric', () => {
  it('uses a lone number directly', () => {
    expect(readReport('metric', '72.5\n')).toEqual({ kind: 'metric', name: 'value', value: 72.5 });
  });
  it('follows a dotted path', () => {
    const content = '{"metrics":{"mutationScore":81}}';
    expect(readReport('metric', content, { metric: 'metrics.mutationScore' })).toEqual({
      kind: 'metric',
      name: 'metrics.mutationScore',
      value: 81,
    });
  });
  it('is unreadable for a missing path, a non-number, an object without a path, or broken JSON', () => {
    expect(readReport('metric', '{"a":1}', { metric: 'a.b' }).kind).toBe('unreadable');
    expect(readReport('metric', '{"a":1}', { metric: 'b' }).kind).toBe('unreadable');
    expect(readReport('metric', '{"a":"1"}', { metric: 'a' }).kind).toBe('unreadable');
    expect(readReport('metric', '{"a":1}').kind).toBe('unreadable');
    expect(readReport('metric', '{"a":').kind).toBe('unreadable');
    expect(readReport('metric', '{"__proto__":{"x":1}}', { metric: 'toString' }).kind).toBe('unreadable');
  });
});

describe('apos-json', () => {
  it('reads tests', () => {
    const content = '{"tests":[{"id":"a::one","status":"pass"},{"id":"a::two","status":"fail","message":"boom"}]}';
    expect(readReport('apos-json', content)).toEqual({
      kind: 'tests',
      tests: [
        { id: 'a::one', status: 'pass' },
        { id: 'a::two', status: 'fail', message: 'boom' },
      ],
    });
  });
  it('reads findings', () => {
    const content = '{"findings":[{"ruleId":"r","level":"error","file":"f.py","line":2}]}';
    expect(readReport('apos-json', content)).toEqual({
      kind: 'findings',
      findings: [{ ruleId: 'r', level: 'error', file: 'f.py', line: 2 }],
    });
  });
  it('is unreadable when broken, empty, or the wrong shape', () => {
    for (const content of [
      fixture('broken.apos.txt'),
      '',
      '{}',
      '[]',
      '{"tests":[{"id":"a","status":"green"}]}',
      '{"tests":[{"status":"pass"}]}',
    ])
      expect(readReport('apos-json', content).kind).toBe('unreadable');
  });
});

describe('junit', () => {
  it('reads vitest: ids use the file as classname, entities decode, skip is skip', () => {
    expect(readReport('junit', fixture('vitest.junit.xml'))).toEqual({
      kind: 'tests',
      tests: [
        { id: 'src/math.test.ts::add > adds two numbers', status: 'pass' },
        {
          id: 'src/math.test.ts::add > rejects "NaN"',
          status: 'fail',
          message: 'expected 1 to be 2',
        },
        { id: 'src/math.test.ts::sub', status: 'skip' },
        { id: 'src/math.test.ts::mul', status: 'pass' },
      ],
    });
  });
  it('reads pytest: failure message from the attribute', () => {
    expect(readReport('junit', fixture('pytest.junit.xml'))).toEqual({
      kind: 'tests',
      tests: [
        { id: 'test_x::test_a', status: 'pass' },
        { id: 'test_x::test_b', status: 'fail', message: 'assert 0' },
      ],
    });
  });
  it('reads jest-junit: message from the body when there is no attribute; no classname falls back to the suite', () => {
    const report = readReport('junit', fixture('jest.junit.xml'));
    expect(report.kind).toBe('tests');
    if (report.kind !== 'tests') return;
    expect(report.tests.map(t => [t.id, t.status])).toEqual([
      ['Cart totals::Cart totals sums items', 'pass'],
      ['Cart totals::Cart totals applies discount', 'fail'],
      ['Cart::loose test', 'pass'],
    ]);
    expect(report.tests[1]?.message).toContain('Expected: 90');
    expect(report.tests[1]?.message).toContain('<anonymous>');
  });
  it('reads Gradle: <error> is error, not fail; CDATA in system-out is ignored', () => {
    expect(readReport('junit', fixture('gradle.junit.xml'))).toEqual({
      kind: 'tests',
      tests: [
        { id: 'com.example.CartAcceptanceTest::totalsItems()', status: 'pass' },
        {
          id: 'com.example.CartAcceptanceTest::brokenSetup()',
          status: 'error',
          message: 'java.lang.IllegalStateException: no db',
        },
        { id: 'com.example.CartAcceptanceTest::later()', status: 'skip' },
      ],
    });
  });
  it('reads Surefire: namespaces and CDATA ok; repeated ids get a stable #n suffix', () => {
    const report = readReport('junit', fixture('surefire.junit.xml'));
    expect(report.kind).toBe('tests');
    if (report.kind !== 'tests') return;
    expect(report.tests.map(t => [t.id, t.status])).toEqual([
      ['com.example.CartUnitTest::params[1]', 'pass'],
      ['com.example.CartUnitTest::params[1]#2', 'pass'],
      ['com.example.CartUnitTest::fails', 'fail'],
    ]);
    expect(report.tests[2]?.message).toBe('expected: <1> but was: <2>');
  });
  it('gives the same ids on every read', () => {
    const a = readReport('junit', fixture('surefire.junit.xml'));
    expect(readReport('junit', fixture('surefire.junit.xml'))).toEqual(a);
  });
  it('takes a testcase with the file attribute when there is no classname', () => {
    const xml = '<testsuite name="s"><testcase file="t/a.py" name="x"/></testsuite>';
    expect(readReport('junit', xml)).toEqual({ kind: 'tests', tests: [{ id: 't/a.py::x', status: 'pass' }] });
  });
  it('a valid report with no testcases is an empty test list, not unreadable', () => {
    expect(readReport('junit', '<testsuites/>')).toEqual({ kind: 'tests', tests: [] });
  });
  it('is unreadable when truncated, mismatched, empty, not XML or not JUnit', () => {
    for (const content of [
      fixture('broken.junit.txt'),
      fixture('mismatched.junit.txt'),
      '',
      'not xml at all',
      '<html><body/></html>',
      '<testsuites><testsuite></testsuites>',
    ]) {
      const report = readReport('junit', content);
      expect(report.kind, content.slice(0, 30)).toBe('unreadable');
    }
  });
});

describe('mergeReports', () => {
  const tests = (id: string): ParsedReport => ({ kind: 'tests', tests: [{ id, status: 'pass' }] });
  it('concatenates tests from several files', () => {
    expect(mergeReports([tests('a::1'), tests('b::2')])).toEqual({
      kind: 'tests',
      tests: [
        { id: 'a::1', status: 'pass' },
        { id: 'b::2', status: 'pass' },
      ],
    });
  });
  it('is unreadable with no files, one unreadable file, or mixed kinds', () => {
    expect(mergeReports([]).kind).toBe('unreadable');
    expect(mergeReports([tests('a::1'), { kind: 'unreadable', reason: 'bad' }])).toEqual({
      kind: 'unreadable',
      reason: 'bad',
    });
    expect(mergeReports([tests('a::1'), { kind: 'findings', findings: [] }]).kind).toBe('unreadable');
  });
});
