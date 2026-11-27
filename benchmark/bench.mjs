#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, toCsv, assertPrivateCorpus, assertPrivateOutput } from './contract.mjs';
import { runSafely } from './run-case.mjs';
import { summarize, metricRows } from './metrics.mjs';
import { corpusDigest } from './digest.mjs';
import { saveCheckpoint, saveRunIdentity } from './checkpoint.mjs';
import { costFields, gateCommandCount } from './cost.mjs';
import { gitEnvironment, gitState } from './env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [corpusArg, outputArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) throw new Error('usage: npm run bench -- <corpus-directory> <new-output-directory>');
const corpus = assertPrivateCorpus(corpusArg);
const output = assertPrivateOutput(root, resolve(outputArg));
const frozenCorpusDigest = corpusDigest(corpus);
const manifestBytes = readFileSync(join(corpus, 'manifest.json'));
const manifest = readManifest(manifestBytes.toString('utf8'));
const hash = input => createHash('sha256').update(input).digest('hex');
const { aposCommit, dirty } = gitState(root);
const cli = join(root, 'dist', 'cli.js');
const versionOf = command => {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', env: gitEnvironment(process.env) });
  return result.status === 0 ? (result.stdout || result.stderr).trim() : null;
};
mkdirSync(output, { mode: 0o700 });
saveRunIdentity(output, {
  corpusDigest: frozenCorpusDigest,
  manifestDigest: hash(manifestBytes),
  aposCommit,
  dirty,
  startedAt: new Date().toISOString(),
});
const rows = [];
for (let repetition = 1; repetition <= 2; repetition++) {
  for (const [index, item] of manifest.cases.entries()) {
    const work = join(output, `run-${repetition}-${index}`);
    const measured = runSafely(item, corpus, cli, work);
    rows.push({
      caseId: item.id,
      repetition,
      gateCommands: gateCommandCount(item.actions),
      goalKind: item.goalKind,
      family: item.family,
      faultType: item.family,
      severity: item.severity,
      deliveryCommit: item.deliveryCommit,
      truth: item.truth,
      expected: item.expected,
      ...measured,
      ...costFields(measured),
      aposCommit,
      aposDirty: dirty,
      nodeVersion: process.version,
      os: `${platform()} ${release()} ${arch()}`,
      cpuModel: cpus()[0]?.model ?? null,
      bundleDigest: hash(readFileSync(join(corpus, item.repository))),
    });
    saveCheckpoint(work, rows.at(-1));
  }
}
if (corpusDigest(corpus) !== frozenCorpusDigest) throw new Error('corpus changed during the run');
const disagreements = manifest.cases.filter(
  item => new Set(rows.filter(row => row.caseId === item.id).map(row => row.actualVerdict)).size > 1,
).length;
const report = {
  manifestDigest: hash(manifestBytes),
  corpusDigest: frozenCorpusDigest,
  environment: {
    node: process.version,
    platform: platform(),
    arch: arch(),
    release: release(),
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    git: versionOf('git'),
    python: versionOf('python'),
    pytest: versionOf('pytest'),
    npm: versionOf('npm'),
    locale: process.env.LC_ALL ?? process.env.LANG ?? null,
    timezone: process.env.TZ ?? null,
    path: process.env.PATH ?? null,
    aposCommit,
    dirty,
  },
  repetitions: 2,
  disagreements,
  summaries: [1, 2].map(rep => summarize(rows.filter(row => row.repetition === rep))),
  rows,
};
writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
const fields = [
  'caseId',
  'deliveryCommit',
  'repetition',
  'goalKind',
  'gateCommands',
  'faultType',
  'severity',
  'truth',
  'expected',
  'actualVerdict',
  'caughtBy',
  'duration',
  'cpu',
  'durationMs',
  'userCpuSeconds',
  'systemCpuSeconds',
  'maxRssKb',
  'evidenceDigest',
  'resultDigest',
  'aposCommit',
  'aposDirty',
  'nodeVersion',
  'os',
  'cpuModel',
  'setupVersion',
  'bundleDigest',
];
writeFileSync(
  join(output, 'results.csv'),
  toCsv(
    rows.map(row => ({
      ...row,
      caughtBy: row.caughtBy === null ? null : JSON.stringify(row.caughtBy),
      evidenceDigest: JSON.stringify(row.evidenceDigest),
    })),
    fields,
  ),
  { mode: 0o600 },
);
writeFileSync(
  join(output, 'summary.csv'),
  toCsv(
    report.summaries.flatMap((summary, index) => metricRows(summary).map(row => ({ repetition: index + 1, ...row }))),
    ['repetition', 'metric', 'family', 'count', 'denominator', 'rate'],
  ),
  { mode: 0o600 },
);
console.log(`Completed ${rows.length} gate runs; results are in the private output directory.`);
