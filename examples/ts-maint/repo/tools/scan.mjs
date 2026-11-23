// The "scanner" of this example: a node script that prints SARIF, like a real scanner would.
// It reports CVE-FMT-1 while package.json pins fmt 1.0.0, and one older finding (LICENSE-1) that is always there.
import { readFileSync, writeFileSync } from 'node:fs';

const pinned = JSON.parse(readFileSync('package.json', 'utf8')).dependencies.fmt;
const finding = (ruleId, level, text, uri, line) => ({
  ruleId,
  level,
  message: { text },
  locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }],
});
const results = [finding('LICENSE-1', 'note', 'the license header is missing', 'src/price.ts', 1)];
if (pinned.endsWith('fmt-1.0.0'))
  results.push(finding('CVE-FMT-1', 'error', 'fmt 1.0.0 formats negative amounts wrongly', 'package.json', 9));
writeFileSync(
  process.argv[2],
  JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'node-scan' } }, results }] }),
);
