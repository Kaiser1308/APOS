import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jsonCodec } from '../domain/setup-codec.js';
import { project } from './bug.test-support.js';

/** One test per row; `fails` says when it fails. Reads the manifest `deps.json` of the checkout it runs in. */
const CHECK = `
const fs = require('fs');
const deps = JSON.parse(fs.readFileSync('deps.json', 'utf8'));
let flip = false;
if (process.env.APOS_FLAKY) {
  const file = process.env.APOS_FLAKY;
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  fs.writeFileSync(file, String(n + 1));
  flip = n % 2 === 1;
}
const cases = [
  ['fmt-api', deps.fmt.startsWith('2.') ? 'fmt 2 renamed format()' : ''],
  ['legacy', fs.existsSync('legacy.flag') ? 'known defect' : ''],
  ['flaky', flip ? 'flipped' : ''],
];
const xml = cases.map(([name, bad]) => '<testcase classname="s" name="' + name + '">' + (bad ? '<failure message="' + bad + '"/>' : '') + '</testcase>').join('');
fs.writeFileSync(process.argv[2], '<testsuite name="s">' + xml + '</testsuite>');
`;

/** A scan that finds CVE-FMT-1 while fmt is 1.0.0, and a defect (OLD-1) that is always there. */
const SCAN = `
const fs = require('fs');
const deps = JSON.parse(fs.readFileSync('deps.json', 'utf8'));
if (process.env.APOS_SCAN_LOG) fs.appendFileSync(process.env.APOS_SCAN_LOG, deps.fmt + ' ' + process.cwd() + '\\n');
const results = [{ ruleId: 'OLD-1', level: 'error', message: { text: 'old defect' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/old.js' }, region: { startLine: 3 } } }] }];
if (deps.fmt === '1.0.0') results.push({ ruleId: 'CVE-FMT-1', level: 'error', message: { text: 'fmt 1.0.0 is vulnerable' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'deps.json' }, region: { startLine: 1 } } }] });
if (process.env.APOS_SCAN_FLAKY) {
  const file = process.env.APOS_SCAN_FLAKY;
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  fs.writeFileSync(file, String(n + 1));
  if (n % 2 === 1) results.push({ ruleId: 'FLAKE-1', level: 'error', message: { text: 'sometimes' } });
}
let severity = deps.extra;
if (process.env.APOS_SCAN_SEVERITY) {
  const file = process.env.APOS_SCAN_SEVERITY;
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  fs.writeFileSync(file, String(n + 1));
  severity = n % 2 === 1 ? 'error' : 'note';
}
if (severity) results.push({ ruleId: 'NEW-1', level: severity, message: { text: 'new finding' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/new.js' } } }] });
fs.writeFileSync(process.argv[2], JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 's' } }, results }] }));
`;

export const manifest = (deps: Record<string, string>) => `${JSON.stringify(deps)}\n`;

/** A repo with a setup whose manifest is `deps.json`, one test layer and (unless `scan: false`) one scan; approved and committed. */
export async function maintProject(
  options: {
    scan?: boolean;
    needsHuman?: string[];
    legacy?: boolean;
    manifests?: boolean;
    deps?: Record<string, string>;
  } = {},
) {
  const p = await project();
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(p.dir, file)), { recursive: true });
    writeFileSync(join(p.dir, file), text);
  };
  put('check.js', CHECK);
  put('scan.js', SCAN);
  put('deps.json', manifest(options.deps ?? { fmt: '1.0.0' }));
  put('src/app.js', 'module.exports = 1;\n');
  if (options.legacy) put('legacy.flag', '1\n');
  const layers = {
    L1: [{ id: 'unit', command: 'node check.js {report}', format: 'junit' }],
    ...(options.scan === false ? {} : { L5: [{ id: 'scan', command: 'node scan.js {report}', format: 'sarif' }] }),
  };
  put(
    '.apos/project.yaml',
    jsonCodec.stringify({
      schemaVersion: 2,
      parts: {
        app: {
          root: '.',
          layers,
          needsHuman: options.needsHuman ?? [],
          forbid: [],
          ...(options.manifests === false ? {} : { manifests: ['deps.json'] }),
        },
      },
    }),
  );
  p.git('add', '-A');
  p.git('commit', '-qm', 'setup');
  const commit = p.git('rev-parse', 'HEAD');
  await p.invoke('setup', 'probe', '--commit', commit);
  await p.invoke('setup', 'approve', '--commit', commit, '--on-behalf', 'test');
  p.out.length = 0;
  const commitFiles = (message: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) put(file, text);
    p.git('add', '-A');
    p.git('commit', '-qm', message);
    return p.git('rev-parse', 'HEAD');
  };
  return {
    ...p,
    commitFiles,
    head: () => p.git('rev-parse', 'HEAD'),
    nodeVersion: execFileSync('node', ['-v']).toString(),
  };
}
