import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { checkGoEntries } from './go-entry.js';

const hasGo = spawnSync('go', ['version']).status === 0;

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
