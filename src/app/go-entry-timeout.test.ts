import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { checkGoEntries } from './go-entry.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  }),
}));

it('fails closed and explains when the Go parser times out', () => {
  const result = checkGoEntries({
    file: 'a_test.go',
    partRoot: '.',
    files: ['go.mod', 'a_test.go'],
    module: 'module example.com/demo\n\ngo 1.22\n',
    text: 'package demo\n',
    allowed: () => true,
  });
  expect(result.join('\n')).toContain('Go parser timed out');
  expect(vi.mocked(execFileSync).mock.calls[0]?.[2]).toMatchObject({ timeout: 120_000 });
});
