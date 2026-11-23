// fmt 1.0.0: money as text. Has the known flaw the scan reports (CVE-FMT-1).
export function format(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
