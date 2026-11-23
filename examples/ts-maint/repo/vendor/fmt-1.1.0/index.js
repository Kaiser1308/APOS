// fmt 1.1.0: the same API, the flaw fixed, one function added.
export function format(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
export function formatCompact(cents) {
  return `$${Math.round(cents / 100)}`;
}
