// fmt 2.0.0: `format` is now `render` (a breaking change).
export function render(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
