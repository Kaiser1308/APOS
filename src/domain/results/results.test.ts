import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readReport } from './index.js';

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
  it.todo('reads vitest, jest-junit, pytest, Gradle and Surefire reports (waits on the XML parser decision)');
  it('is unreadable for now, never an exception or an empty green report', () => {
    expect(readReport('junit', '<testsuites/>')).toEqual({ kind: 'unreadable', reason: 'junit reader pending' });
  });
});
