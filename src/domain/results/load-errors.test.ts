import { expect, it } from 'vitest';
import { loadFailure } from './load-errors.js';

const t = (id: string, status: 'pass' | 'fail' | 'error' | 'skip', message?: string) => ({
  id,
  status,
  ...(message ? { message } : {}),
});

it('says nothing ran when every test errored (pytest collection failure)', () => {
  expect(
    loadFailure([t('tests.acceptance.test_calc::tests.acceptance.test_calc', 'error', 'collection failure')]),
  ).toBe('tests could not load: collection failure');
  expect(loadFailure([t('a::x', 'error'), t('a::y', 'error')])).toBe('tests could not load: a::x');
});
it('recognises a load error among passing tests by the stack patterns, first line only', () => {
  const tests = [t('a::ok', 'pass'), t('b::mod', 'error', 'ImportError while importing test module\nTraceback ...')];
  expect(loadFailure(tests, ['ImportError while importing'])).toBe(
    'tests could not load: ImportError while importing test module',
  );
  expect(loadFailure(tests)).toBeUndefined();
});
it('lets an ordinary failing test through', () => {
  expect(
    loadFailure([t('a::ok', 'pass'), t('a::bad', 'fail', 'assert 1 == 2')], ['collection failure']),
  ).toBeUndefined();
  expect(loadFailure([])).toBeUndefined();
  expect(loadFailure([t('a::s', 'skip')], ['x'])).toBeUndefined();
});
