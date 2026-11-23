// The story of examples/ts-maint, told through the real binary (see scripts/demo-goal.mjs, which calls this):
// a dependency (fmt, a folder in vendor/: no network) carries a finding, the Goal is one command to open and one for the
// Human to approve, and the gate holds every delivery to the base: a new failure is red, a file outside the manifests is
// red, and the upgrade that removes the finding and nothing else is green.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function maintenanceStory({ apos, git, commit, expectText, human, source, repo }) {
  const brief = JSON.parse(readFileSync(join(source, 'maintenance.json'), 'utf8'));
  const id = 'GOAL-MAINT-001';
  const manifest = join(repo, 'package.json');
  /** A commit on top of `parent` that pins fmt to `version` (and, with `touch`, edits a source file too). */
  const upgrade = (branch, parent, version, touch) => {
    git('checkout', '-q', '-B', branch, parent);
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/fmt-\d+\.\d+\.\d+/, `fmt-${version}`));
    if (touch)
      writeFileSync(join(repo, touch), `// touched by the upgrade\n${readFileSync(join(repo, touch), 'utf8')}`);
    return commit(`upgrade fmt to ${version}${touch ? ` and touch ${touch}` : ''}`);
  };

  expectText(
    apos(
      0,
      'the PM opens a maintenance Goal that must remove CVE-FMT-1; the base is scanned once, and the finding is found there',
      'maintenance',
      'open',
      brief.description,
      '--security',
      brief.security,
      '--paths',
      brief.paths,
    ),
    `apos maintenance approve ${id}`,
  );
  expectText(apos(0, 'it waits for the Human in the inbox', 'inbox'), `apos maintenance approve ${id}`);
  apos(
    0,
    'the Human approves, sets the default appetite and selects, in one command',
    'maintenance',
    'approve',
    id,
    ...human,
  );
  apos(
    0,
    'the Lead plans it: one Solo package, no Tester; its paths are the manifests plus the declared path',
    'lead',
    'propose',
    '--maintenance',
    '--goal',
    id,
  );
  apos(0, 'the Lead commits the plan: the Goal is executing', 'lead', 'commit', id);

  const major = upgrade('major', 'main', '2.0.0');
  expectText(
    apos(
      1,
      'the Worker upgrades to fmt 2.0.0, which renames format(): a test green on the base is red now, so it is red',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      major,
    ),
    'new failure(s) vs the base',
  );
  const wide = upgrade('wide', 'main', '1.1.0', 'src/price.ts');
  expectText(
    apos(
      1,
      'the Worker upgrades to 1.1.0 and also edits src/price.ts: not a manifest and not a declared path, so it is red',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      wide,
    ),
    'outside the package paths',
  );
  const minor = upgrade('minor', 'main', '1.1.0');
  expectText(
    apos(
      3,
      'the Worker upgrades to 1.1.0 and nothing else: package.json is a sensitive file, so the gate waits for a decision',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      minor,
    ),
    'sensitive files changed',
  );
  apos(
    0,
    'an agent approves the manifest change on the Human’s behalf (the table will say so)',
    'exception',
    'approve',
    id,
    '--kind',
    'needs-human',
    '--ref',
    'WP-MAIN',
    '--reason',
    'a dependency upgrade changes package.json by definition',
    '--by',
    'agent:lead',
  );
  expectText(
    apos(
      0,
      'the same commit again: no new failure, no new finding, CVE-FMT-1 gone, only the manifest changed: green',
      'package',
      'submit',
      id,
      'WP-MAIN',
      '--commit',
      minor,
    ),
    'verified',
  );
  apos(0, 'the Human closes the Goal on the commit that passed the gate', 'outcome', 'close', id, ...human);
  expectText(
    apos(0, 'the assurance table says what was proved against the base', 'goal', 'show', id),
    'không còn trên',
  );
}
