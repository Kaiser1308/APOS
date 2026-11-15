import { describe, expect, it } from 'vitest';
import { InvariantError, UserError } from './errors.js';

describe.each([
  ['UserError', UserError],
  ['InvariantError', InvariantError],
] as const)('%s', (name, ErrorClass) => {
  it('is an Error that keeps its message and name', () => {
    const error = new ErrorClass('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.message).toBe('boom');
    expect(error.name).toBe(name);
  });

  it('preserves the cause', () => {
    const cause = new Error('root');
    expect(new ErrorClass('boom', { cause }).cause).toBe(cause);
  });
});

it('keeps the two kinds apart', () => {
  expect(new UserError('x')).not.toBeInstanceOf(InvariantError);
  expect(new InvariantError('x')).not.toBeInstanceOf(UserError);
});
