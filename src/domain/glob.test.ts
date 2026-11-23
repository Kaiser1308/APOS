import { describe, expect, it } from 'vitest';
import { globsOverlap, matchesAny } from './glob.js';

describe('glob', () => {
  it('matches ** across directories and * within one', () => {
    expect(matchesAny('tests/a/b.py', ['tests/**'])).toBe(true);
    expect(matchesAny('src/x/foo.test.ts', ['**/*.test.ts'])).toBe(true);
    expect(matchesAny('foo.test.ts', ['**/*.test.ts'])).toBe(true);
    expect(matchesAny('src/a/b.ts', ['src/*.ts'])).toBe(false);
    expect(matchesAny('./src/a.ts', ['src/*.ts'])).toBe(true);
  });
  it('treats overlapping globs coarsely: equal, or one matches the other as a literal', () => {
    expect(globsOverlap('src/**', 'src/a/**')).toBe(true);
    expect(globsOverlap('src/a.ts', 'src/**')).toBe(true);
    expect(globsOverlap('src/a/**', 'lib/**')).toBe(false);
  });
});
