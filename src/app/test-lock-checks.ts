import { entryViolations } from '../domain/entry-rule.js';
import { matchesAny, rootedGlobs } from '../domain/glob.js';
import type { ProjectSetup } from '../domain/project-setup.js';
import { acceptanceProof, needsTest } from '../domain/test-plan.js';
import {
  countAsserts,
  judgeSuite,
  outcomeSignature,
  testMapPath,
  testMapSchema,
  type LayerOutcome,
  type LockedLayer,
  lockedTestKeys,
  testKey,
  type TestLock,
  type TestMapEntry,
} from '../domain/test-lock.js';
import type { GoalState } from '../domain/transitions.js';
import type { CommitInspector } from '../ports/commit-inspector.js';
import type { GoalRepository } from '../ports/goal-repository.js';
import { fileAt, filesAt, sha256Of } from './git-files.js';
import type { ToolRunner } from './layer-runner.js';
import { untrustedProtectedFiles } from './protected-milestones.js';

export type Inspection = {
  problems: string[];
  /** Only for a revision: ways the new suite is weaker than the locked one. They wait for an approved exception. */
  weakened: string[];
  files: Record<string, string>;
  asserts: Record<string, number>;
  map: TestMapEntry[];
  /** sha256 of every test-infrastructure file at the commit. */
  infra: Record<string, string>;
  /** Tests per mapped layer, for the summary `apos tests show` prints. */
  testCount: number;
};

export type InspectInput = {
  store: GoalRepository;
  repo: string;
  state: GoalState;
  setup: ProjectSetup;
  commit: string;
  /** What the commit must contain, and the commit its diff is read from: the plan base, or the lock being revised. */
  from: string;
  inspector: CommitInspector;
  runner: ToolRunner;
  /** The lock this commit would replace: deleting or weakening is then a decision to approve, not a refusal. */
  revising?: TestLock;
};

/**
 * Looks at one commit of tests the way `apos tests submit` and `revise` both need: what it touches, whether the map
 * covers every criterion, whether every test loads and is red (or green) for the right reason, whether two runs agree.
 * It reports every problem it finds, in that order, and hashes and counts the files it would lock.
 */
export function inspectTests(input: InspectInput): Inspection {
  const { state, setup, commit, from, inspector, repo } = input;
  const goalId = state.spec.id;
  const problems: string[] = [];
  const testParts = Object.entries(setup.parts).filter(([, part]) => part.tests);
  if (!testParts.length)
    problems.push('the pinned setup declares no tests (parts.<name>.tests.paths): draft or revise the setup first');
  if (!inspector.contains(repo, from, commit))
    problems.push(`commit ${commit} does not contain ${from}: rebase onto it`);

  const stubs = [
    state.proposal?.stubPaths ?? [],
    ...Object.values(state.packages ?? {}).map(item => item.spec.stubPaths ?? []),
  ].flat();
  const mapPath = testMapPath(goalId);
  const changed = inspector.files(repo, commit, from);
  const owner = (file: string) =>
    testParts.find(([, part]) => matchesAny(file, rootedGlobs(part.root, part.tests!.paths)));
  const infraGlobs = testParts.flatMap(([, part]) => rootedGlobs(part.root, part.tests!.infra));
  const foreign = untrustedProtectedFiles(input.store, goalId, repo, commit, changed);
  const testFiles: string[] = [];
  for (const file of changed) {
    if (file === mapPath || matchesAny(file, stubs) || matchesAny(file, infraGlobs)) continue;
    if (file.startsWith('.apos/')) {
      if (foreign.includes(file)) problems.push(`${file}: APOS-managed file changed`);
      continue;
    }
    if (owner(file)) testFiles.push(file);
    else
      problems.push(
        `${file}: not a test file (tests.paths), a declared stub, or ${mapPath}: a tester may touch only those`,
      );
  }

  let map: TestMapEntry[] = [];
  const mapText = fileAt(repo, commit, mapPath);
  if (!mapText) problems.push(`${mapPath} is missing from the commit`);
  else {
    let raw: unknown;
    try {
      raw = JSON.parse(mapText.toString('utf8'));
    } catch {
      problems.push(`${mapPath} is not valid JSON`);
    }
    const parsed = raw === undefined ? undefined : testMapSchema.safeParse(raw);
    if (parsed && !parsed.success)
      problems.push(
        `${mapPath}: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    else if (parsed) map = parsed.data;
  }

  const criteria = new Map(state.spec.acceptance.map(item => [item.id, item]));
  for (const item of state.spec.acceptance.filter(needsTest))
    if (!map.some(entry => entry.acceptanceId === item.id))
      problems.push(
        `${item.id} has no test in ${mapPath}: every ${acceptanceProof(item)} criterion needs at least one`,
      );
  for (const entry of map) {
    if (!criteria.has(entry.acceptanceId))
      problems.push(`${mapPath} names ${entry.acceptanceId}, which is not a criterion of this Goal`);
    const part = setup.parts[entry.part];
    if (!part) problems.push(`${mapPath} names part "${entry.part}", which the setup does not have`);
    else if (!part.layers[entry.layer]?.length)
      problems.push(
        `${mapPath}: part "${entry.part}" has no ${entry.layer} tool in the setup, so ${entry.acceptanceId} cannot be run there`,
      );
  }

  const outcomes: LayerOutcome[] = [];
  const second: LayerOutcome[] = [];
  const layers = new Map<string, { part: string; layer: LockedLayer }>();
  for (const entry of map)
    if (setup.parts[entry.part]?.layers[entry.layer]) layers.set(`${entry.part}.${entry.layer}`, entry);
  let ran = true;
  const run = (target: LayerOutcome[]) => {
    for (const { part, layer } of layers.values()) {
      const where = setup.parts[part]!;
      const result = input.runner.layerTests(commit, part, where.root, layer, where.layers[layer] ?? []);
      if (result.problems.length) ran = false;
      problems.push(...(target === outcomes ? result.problems : []));
      target.push({ part, layer, tests: result.tests });
    }
  };
  run(outcomes);
  if (ran)
    problems.push(
      ...judgeSuite({
        map,
        proofOf: id => {
          const item = criteria.get(id);
          const proof = item ? acceptanceProof(item) : undefined;
          return proof === 'benchmark' || proof === 'scan' ? undefined : proof;
        },
        outcomes,
        patterns: Object.fromEntries(
          Object.entries(setup.parts).map(([name, part]) => [
            name,
            {
              notImplemented: part.tests?.notImplementedPatterns ?? [],
              loadError: part.tests?.loadErrorPatterns ?? [],
            },
          ]),
        ),
      }),
    );
  if (ran && !problems.length) {
    run(second);
    for (const first of outcomes) {
      const again = second.find(item => item.part === first.part && item.layer === first.layer);
      if (!again || outcomeSignature(again.tests) !== outcomeSignature(first.tests))
        problems.push(
          `${first.part}.${first.layer}: two runs of the same commit gave different results (flaky): nothing is locked`,
        );
    }
  }

  const files: Record<string, string> = {};
  const asserts: Record<string, number> = {};
  const weakened: string[] = [];
  // The files that hold the mapped tests are locked even when the tester did not change them (a stays-green test).
  const treeFiles = filesAt(repo, commit);
  const holders = new Set(testFiles);
  const acceptanceHolders = new Map<string, string>();
  if (ran)
    for (const outcome of outcomes) {
      const where = setup.parts[outcome.part]!;
      const candidates = treeFiles.filter(
        file => matchesAny(file, rootedGlobs(where.root, where.tests?.paths ?? [])) && !matchesAny(file, infraGlobs),
      );
      for (const entry of map.filter(item => item.part === outcome.part && item.layer === outcome.layer))
        for (const id of entry.testIds) {
          const test = outcome.tests.find(item => item.id === id);
          if (!test) continue;
          const holder = holderOf(candidates, where.root, test);
          if (holder) {
            holders.add(holder);
            if (entry.layer === 'L2') acceptanceHolders.set(holder, outcome.part);
          } else
            problems.push(
              `${entry.acceptanceId} ${entry.part}.${entry.layer} ${id}: cannot tell which file holds this test, so it cannot be locked`,
            );
        }
    }
  // Acceptance tests go through the declared entries only, for the stacks whose catalog says how to read an import.
  const present = new Set(treeFiles);
  for (const [file, partName] of acceptanceHolders) {
    const where = setup.parts[partName]!;
    const rule = where.tests?.entryRule;
    const text = fileAt(repo, commit, file);
    if (!rule || !text) continue;
    problems.push(
      ...entryViolations({
        rule,
        file,
        text: text.toString('utf8'),
        partRoot: where.root,
        exists: path => present.has(path),
        allowed: path => matchesAny(path, stubs) || matchesAny(path, rootedGlobs(where.root, where.tests?.paths ?? [])),
      }),
    );
  }
  for (const file of holders) {
    const content = fileAt(repo, commit, file);
    if (!content) {
      if (input.revising?.files[file] !== undefined) weakened.push(`${file}: a locked test file was deleted`);
      else problems.push(`${file}: a test file was deleted; removing a test needs an approved exception`);
      continue;
    }
    files[file] = sha256Of(content);
    asserts[file] = countAsserts(content.toString('utf8'), owner(file)?.[1].tests?.assertPatterns ?? []);
  }
  const infra: Record<string, string> = {};
  for (const file of treeFiles)
    if (matchesAny(file, infraGlobs)) {
      const content = fileAt(repo, commit, file);
      if (content) infra[file] = sha256Of(content);
    }
  const before = input.revising;
  if (before) {
    // A locked file the revision did not touch is carried over unchanged.
    for (const [path, hash] of Object.entries(before.files))
      if (!(path in files) && !testFiles.includes(path)) {
        files[path] = hash;
        asserts[path] = before.asserts[path] ?? 0;
      }
    const now = new Set(map.flatMap(entry => entry.testIds.map(id => testKey(entry.part, entry.layer, id))));
    for (const key of lockedTestKeys(before))
      if (!now.has(key)) weakened.push(`locked test removed or renamed: ${key}`);
    const count = (list: TestMapEntry[], id: string) =>
      list.filter(entry => entry.acceptanceId === id).reduce((sum, entry) => sum + entry.testIds.length, 0);
    for (const id of new Set(before.map.map(entry => entry.acceptanceId)))
      if (count(map, id) < count(before.map, id))
        weakened.push(`${id} has fewer tests than before (${count(map, id)} < ${count(before.map, id)})`);
    for (const [path, old] of Object.entries(before.asserts))
      if ((asserts[path] ?? 0) < old) weakened.push(`${path}: asserts fell from ${old} to ${asserts[path] ?? 0}`);
  }
  return {
    problems,
    weakened,
    infra,
    files,
    asserts,
    map,
    testCount: map.reduce((sum, entry) => sum + entry.testIds.length, 0),
  };
}

/** The file a reported test lives in: the report's `file` attribute, or the class name read as a path or a dotted module. */
function holderOf(candidates: string[], root: string, test: { id: string; file?: string }): string | undefined {
  const classname = (test.id.split('::')[0] ?? '').replaceAll('\\', '/');
  const dotted = classname.split('$')[0]!;
  const given = test.file?.replaceAll('\\', '/');
  const asFile = given && (root === '.' ? given : `${root}/${given}`);
  return candidates.find(file => {
    const bare = file.replace(/\.[^./]+$/, '').replaceAll('/', '.');
    return file === asFile || file === classname || bare === dotted || bare.endsWith(`.${dotted}`);
  });
}
