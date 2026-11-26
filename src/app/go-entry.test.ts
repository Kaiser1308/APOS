import { execFileSync, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { checkGoEntries } from './go-entry.js';

const hasGo = spawnSync('go', ['version']).status === 0;

it.skipIf(!hasGo)('rejects a same-package test helper that imports an undeclared internal package', () => {
  const source: Record<string, string> = {
    'acceptance_test.go': 'package calc_test\nimport "testing"\nfunc TestCalc(t *testing.T) { helper() }\n',
    'helper_test.go': 'package calc_test\nimport "example.com/demo/internal"\nfunc helper() { internal.Secret() }\n',
    'internal/secret.go': 'package internal\nfunc Secret() {}\n',
  };
  const result = checkGoEntries({
    file: 'acceptance_test.go',
    partRoot: '.',
    files: ['go.mod', ...Object.keys(source)],
    module: 'module example.com/demo\n',
    text: source['acceptance_test.go']!,
    read: path => source[path],
    allowed: path => path.endsWith('_test.go'),
  });
  expect(result).toEqual([expect.stringContaining('internal/secret.go')]);
});

it.skipIf(!hasGo)('checks imports in same-package and imported test helper source files', () => {
  const source: Record<string, string> = {
    'tests/a_test.go': 'package calc_test\nimport "example.com/demo/tests/support"\n',
    'tests/helper.go': 'package calc_test\nimport "example.com/demo/internal"\n',
    'tests/support/helper.go': 'package support\nimport "example.com/demo/internal"\n',
    'internal/secret.go': 'package internal\n',
  };
  const result = checkGoEntries({
    file: 'tests/a_test.go',
    partRoot: '.',
    files: ['go.mod', ...Object.keys(source)],
    module: 'module example.com/demo\n',
    text: source['tests/a_test.go']!,
    read: path => source[path],
    allowed: path => path.startsWith('tests/'),
    isTestFile: path => path.startsWith('tests/'),
  });
  expect(result.join('\n')).toContain('tests/helper.go');
  expect(result.join('\n')).toContain('tests/support/helper.go');
});

it.skipIf(!hasGo)('ignores same-package test helpers excluded by the Go build context', () => {
  const targetOS = execFileSync('go', ['env', 'GOOS'], { encoding: 'utf8' }).trim();
  const otherOS = targetOS === 'windows' ? 'linux' : 'windows';
  const source: Record<string, string> = {
    'a_test.go': 'package calc_test\nimport "testing"\nfunc TestA(t *testing.T) {}\n',
    'helper_test.go': '//go:build apos_never\n\npackage calc_test\nimport "example.com/demo/internal"\n',
    [`helper_${otherOS}_test.go`]: 'package calc_test\nimport "example.com/demo/internal"\n',
    'internal/secret.go': 'package internal\n',
  };
  const result = checkGoEntries({
    file: 'a_test.go',
    partRoot: '.',
    files: ['go.mod', ...Object.keys(source)],
    module: 'module example.com/demo\n\ngo 1.22\n',
    text: source['a_test.go']!,
    read: path => source[path],
    allowed: path => path.endsWith('_test.go'),
  });
  expect(result).toEqual([]);
  const conservative = checkGoEntries({
    file: 'a_test.go',
    partRoot: '.',
    files: ['go.mod', ...Object.keys(source)],
    module: 'module example.com/demo\n',
    text: source['a_test.go']!,
    read: path => source[path],
    allowed: path => path.endsWith('_test.go'),
    conservativeBuild: true,
  });
  expect(conservative.join('\n')).toContain('internal/secret.go');
});

it.skipIf(!hasGo)('checks tagged helpers when GOFLAGS selects tags and ignores other test packages', () => {
  const old = process.env.GOFLAGS;
  process.env.GOFLAGS = '-tags=apos_custom';
  try {
    const source: Record<string, string> = {
      'a_test.go': 'package calc_test\nimport "testing"\nfunc TestA(t *testing.T) {}\n',
      'tagged_test.go': '//go:build apos_custom\n\npackage calc_test\nimport "example.com/demo/internal"\n',
      'other_test.go': 'package calc\nimport "example.com/demo/internal"\n',
      'internal/secret.go': 'package internal\n',
    };
    const result = checkGoEntries({
      file: 'a_test.go',
      partRoot: '.',
      files: ['go.mod', ...Object.keys(source)],
      module: 'module example.com/demo\n',
      text: source['a_test.go']!,
      read: path => source[path],
      allowed: path => path.endsWith('_test.go'),
    });
    expect(result.join('\n')).toContain('tagged_test.go');
    expect(result.join('\n')).not.toContain('other_test.go');
  } finally {
    if (old === undefined) delete process.env.GOFLAGS;
    else process.env.GOFLAGS = old;
  }
});

it.skipIf(!hasGo)('does not exclude future-toolchain helpers when the module requests a newer Go version', () => {
  const source: Record<string, string> = {
    'a_test.go': 'package calc_test\nimport "testing"\nfunc TestA(t *testing.T) {}\n',
    'future_test.go': '//go:build go1.999\n\npackage calc_test\nimport "example.com/demo/internal"\n',
    'internal/secret.go': 'package internal\n',
  };
  const result = checkGoEntries({
    file: 'a_test.go',
    partRoot: '.',
    files: ['go.mod', ...Object.keys(source)],
    module: 'module example.com/demo\n\ngo 1.999\n',
    text: source['a_test.go']!,
    read: path => source[path],
    allowed: path => path.endsWith('_test.go'),
  });
  expect(result.join('\n')).toContain('internal/secret.go');
});

it.skipIf(!hasGo)('resolves an import of the module root to its source files', () => {
  const input = {
    file: 'acceptance_test.go',
    partRoot: '.',
    files: ['go.mod', 'calc.go'],
    module: 'module example.com/demo\n',
    text: 'package calc_test\nimport "example.com/demo"\n',
    allowed: (path: string) => path === 'calc.go',
    read: () => 'package calc\n',
  };
  expect(checkGoEntries(input)).toEqual([]);
});

it.skipIf(!hasGo)('checks all files of an imported Go package without confusing standard or external imports', () => {
  const files = ['service/go.mod', 'service/api/a.go', 'service/api/b.go', 'service/internal/secret.go'];
  const input = {
    file: 'service/tests/acceptance_test.go',
    partRoot: 'service',
    files,
    module: 'module example.com/demo\n',
    text: 'package acceptance_test\nimport (\n "testing"\n "example.com/demo/api"\n "example.net/dependency"\n)\n',
    allowed: (path: string) => path === 'service/api/a.go',
  };
  expect(checkGoEntries(input)).toEqual([expect.stringContaining('service/api/b.go')]);
  expect(checkGoEntries({ ...input, allowed: (path: string) => path.startsWith('service/api/') })).toEqual([]);
});

it.skipIf(!hasGo)('rejects unresolved local imports and replace directives instead of guessing', () => {
  const input = {
    file: 'test.go',
    partRoot: '.',
    files: ['go.mod'],
    module: 'module example.com/demo\n',
    text: 'package demo_test\nimport "example.com/demo/missing"\n',
    allowed: () => false,
  };
  expect(checkGoEntries(input)).toEqual([expect.stringContaining('cannot resolve')]);
  expect(checkGoEntries({ ...input, module: 'module example.com/demo\nreplace example.net/x => ../x\n' })).toEqual([
    expect.stringContaining('replace'),
  ]);
});

it.skipIf(!hasGo)('blocks same-package access to undeclared source and workspace modules', () => {
  const input = {
    file: 'api/acceptance_test.go',
    partRoot: '.',
    files: ['go.mod', 'api/service.go'],
    module: 'module example.com/demo\n',
    text: 'package api\nimport "testing"\n',
    allowed: () => false,
    read: () => 'package api\n',
  };
  expect(checkGoEntries(input)).toEqual([expect.stringContaining('same-package')]);
  expect(checkGoEntries({ ...input, files: [...input.files, 'go.work'] })).toEqual([
    expect.stringContaining('workspace'),
  ]);
});
