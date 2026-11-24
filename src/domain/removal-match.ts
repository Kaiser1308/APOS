/**
 * Whether a declared test covers a test key (`<part>.<layer>::<id>`): the same id, every test of a file (`<file>::<name>`),
 * a repeated id (`#2`) or a parametrized one (`name[...]`). A neighbour that merely starts with the same letters is not covered.
 */
export const entryMatches = (entry: string, key: string): boolean =>
  key === entry || ['::', '#', '['].some(next => key.startsWith(entry + next));
