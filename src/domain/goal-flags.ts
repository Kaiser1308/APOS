import type { GoalState } from './transitions.js';

/** The flag that turns mutation testing on: a setup tool that says `when: flag:mutation` runs only for such a Goal. */
export const MUTATION_FLAG = 'mutation';
export const FLAG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The flags of a Goal: the ones its document names and the ones the Human added at `goal approve --flag`. */
export const goalFlagsOf = (state: GoalState): string[] => [
  ...new Set([...(state.spec.flags ?? []), ...(state.flags ?? [])]),
];
