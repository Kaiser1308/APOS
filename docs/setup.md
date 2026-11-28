# Bringing a project into APOS: the setup

The setup (`.apos/project.yaml`, `schemaVersion: 2`) is the only thing that decides what the gate runs for a project. It is protected: a delivery that edits it fails the gate (`APOS-PROTECTED`). A repo from before v2 (`schemaVersion: 1`) still works and counts as "no setup": every guarantee that depends on a setup is off and the Goal's own checks run as before.

Setup files use YAML. Existing setup files containing JSON remain readable because JSON is valid YAML. APOS hashes the exact setup text after normalizing CRLF and CR line endings to LF.

## The steps

`apos init` comes first: it creates `.apos/project.yaml` (empty setup), installs the role skills, and writes a managed block into `AGENTS.md` (plus `@AGENTS.md` in `CLAUDE.md`) that points agents at the setup and the rules of the gate. The block sits between `<!-- apos:begin ... -->` and `<!-- apos:end -->`; `init` replaces only that part on a rerun. `apos init --no-agents-md` skips both files.

```
apos setup draft     # Lead: write a draft from the catalog (not committed)
  edit, then commit .apos/project.yaml
apos setup probe     # APOS: run every tool at that commit in clean worktrees
apos setup approve --commit <sha>      # Human
apos setup show      # the latest approved version
```

1. **Draft.** `apos setup draft [--part <name>=<dir>[:<stack>]]... [--force]` detects the stack of the repo root and of each directory one level down, then takes the first tool of each layer plus the stack's strict floor (forbidden patterns, sensitive files, `mutation.minScore: 70` when a Goal asks for mutation). It prints notes for anything it could not name: a part whose stack is not recognised stays empty with the note `chưa nhận ra stack`; it never guesses. It refuses to overwrite a v2 setup that already has parts without `--force`.
2. **Edit and commit.** Add or remove tools, set `floor`, `triggers`, `system` layers. The setup is judged from the commit, not the working tree.
3. **Probe.** `apos setup probe [--commit <rev>]` runs every tool in a clean worktree and records `setup-probed` in the project log. A tool passes when: the command runs (not "command not found", no timeout); its report reads, and a `junit` report holds at least one test that loaded (a report where every test errored, or one that matches the stack's `loadErrorPatterns`, fails with `tests could not load`); `runOne` run on the first test that ran produces exactly one test that did not skip, with the same id; L1 and L2 give the same ids and statuses on two runs. A setup with no tool does not pass.

   **A repo with no tests** is not a broken tool. When a test tool runs, says there is no test (the exit code or the words the stack's catalog declares: pytest exits 5, vitest prints "No test files found") and its report holds no test, the probe records that layer as `no-tests` instead of failing it, and says so (`none app.L1 pytest: the tool reports no tests`). Nothing else counts: another exit code (pytest exits 4 for a path that does not exist), a tool that crashes, a config that does not load and a command that is not installed fail the probe as before, and a report that holds tests overrules the signal. A stack whose catalog declares no signal (Java today) cannot tell, so its probe of an empty repo fails. **An empty layer is still judged like any layer.** The label judges nothing differently: at the gate and at `outcome close` a layer whose tool finds no test is red (exit 5) or `unverifiable`, never green. For a legacy repo list in the setup only the layers that have tests to run (the example `py-legacy` keeps L2, where the captured tests go, and drops L1 and L3), approve that setup, and add a layer back when it has tests; or cut a layer that cannot apply with a `floor-reduced` exception, which the table shows. The layers a stack reads this way need the folder their tool points at to exist: `tests/acceptance/` and `tests/integration/` hold a `.gitkeep` in the example `py-legacy`, because `pytest tests/acceptance` on a missing folder is exit 4.
4. **Approve.** `apos setup approve --commit <sha> [--baseline-missing]` is a Human decision: type the commit back in a terminal, or pass `--on-behalf "<why>"`. It needs the latest probe of exactly that text (same sha256) at exactly that commit to have passed: a setup edited after its probe is refused, and so is a commit that was never probed (`Chưa probe ở commit này`), even if the same text passed at another commit. Each approval is a new version, 1, 2, 3 ...

   **No tests means a label, and a Human's decision.** A probe with a `no-tests` layer is approved only with `--baseline-missing`: the repo has no baseline, so what the gates prove is weak, and the Human accepts that knowingly (the same confirmation as any approval, so an agent never does it for them). The approval event carries `assurance: baseline-missing` and the layers that have no tests (`app.L1, app.L2`); the flag is refused when the probe found tests everywhere, so the label is never false. Every Goal approved on that setup copies the label: its [assurance table](../README.md#the-assurance-table) opens with `BẢO ĐẢM THẤP: repo chưa có test nền (app.L1, app.L2)`, and `apos inbox` and `goal show` say it too. The label adds a warning and removes no check: a Goal on a low-assurance setup is gated exactly like any other (see the note on empty layers above).

   **The label does not wear off.** It goes only when a new setup version is approved on a probe that finds tests. After a characterize Goal has closed and its tests are in the repo, probe again at the new commit and `apos setup approve --commit <sha>` (no flag); the same text of the setup is accepted again for this, and the new version has no label. Goals on the old version keep theirs. Then see [Old repo, few tests](../README.md#an-old-repo-with-few-tests).

## Workspaces and dependencies

Each Goal command check invocation and each setup tool invocation runs in its own fresh detached worktree at the requested commit. This includes repeated runs, base and delivery, and rechecks. The worktree is removed after the invocation, so a tool cannot depend on an earlier tool or check having built `dist/` or written another uncommitted file. Chain the preparation and the consumer in the same command, for example `npm run build && node dist/dry-run.js`. Goal manual checks use a recorded confirmation; built-in assurance checks are not all commands run in worktrees.

A worktree contains the committed files, not uncommitted files from the original checkout. For a root `package.json` with `package-lock.json`, APOS prepares Node dependencies: it may copy the original checkout’s `node_modules` when the lockfiles match and there are no workspace or `file:` links or root install scripts; otherwise it runs `npm ci`. Links inside the dependency tree are redirected into the copy; links outside it cause a fresh install. A committed `node_modules` directory is left as is only when its links stay within that directory; a top-level `node_modules` link is removed and dependencies are prepared separately. Without a root lockfile APOS does not prepare dependencies. Dependency preparation is not a build step and is not a guarantee that other generated artifacts exist. Other dependencies and external services must be available to the command itself. Goal check logs record the dependency preparation.

Logs and reports are stored outside the worktree as gate evidence. The `{report}` placeholder supplies an external report path for APOS to read; it is not a way to pass build output between checks.

## Format of the file

```yaml
schemaVersion: 2
parts: # one per technology; roots must differ
  backend:
    root: backend
    stack: java-gradle
    layers:
      L1: [ ...tools ]
    needsHuman: [ ... ]
    forbid: [ ... ]
system: # layers that span parts
  L4: [ ...tools ]
floor:
  submit: [L0, L1, L2]
  integrate: [L1, L2, L3]
  close: [L0, L1, L2, L3, L4, L5]
triggers:
  - when:
      changed: ["frontend/src/ui/**"]
    at: submit
    run: ["system.L4"]
mutation:
  minScore: 70
```

Use `apos setup draft` to write an editable YAML file with a link to this guide at the top. A part may also say where its tests are and how to read them:

```
tests: { paths: ["tests/**", "**/test_*.py"],      # globs relative to the part's root
         assertPatterns: ["^\\s*assert\\b"],        # one regex per kind of assertion, matched line by line
         notImplementedPatterns: ["NotImplementedError"],   # a stub's "not done yet", in a failing test's message
         loadErrorPatterns: ["ImportError while importing test module"] }   # a test that never loaded
```

`infra` lists **test infrastructure**: files that change how tests run without being tests (`conftest.py`, `pytest.ini`, `pyproject.toml`, `vitest.config.*`, setup files, `src/test/resources/**`). Add the ones your project has. `apos tests submit` hashes every file that matches at the lock commit; afterwards a package that changes, adds or deletes one gets `needs-human` (`APOS-INFRA`), because a broad `paths` (`tests/**`, `**`) would otherwise let a package add a `conftest.py` hook that swallows the failure of a locked test, or a `setupFiles` entry that mocks the code under test, and report the locked red test as green.

`manifests` (copied from the catalogue's `manifests`; absent on a setup approved before it) are the globs, relative to the part's `root`, of the manifests and lockfiles a `maintenance` Goal may change (`apos maintenance open`): with them the plan's `paths` are the manifests plus the Goal's `--paths`, and the gate is red for any other changed file. A setup without them cannot plan a maintenance Goal (`lead propose --maintenance` says to add them and approve the setup again). A security Goal also needs a scan: a tool in `L5` with `format: sarif` that runs without a flag; without one, `maintenance open --security` and `maintenance approve` refuse. The scan's findings are read by fingerprint (SARIF `partialFingerprints`, else rule + path + message), see [README](../README.md#upgrading-a-dependency-or-patching-a-finding-apos-maintenance).

`entryRule` (copied from the catalogue; absent for a stack that has none) tells `apos tests submit` how to read an import in an acceptance test and where the module lives, so a test that imports an internal module that is not a declared stub is refused. See [catalog.md](catalog.md#entryrule).

`draft` copies these from the catalogue (`testPaths`, `testInfra`, `assertPatterns`, `notImplementedPatterns`, `loadErrorPatterns`, `entryRule`). The probe checks that every pattern compiles. They are what locks acceptance tests (`apos tests submit`): which files a tester may commit and lock, which failures count as red for the right reason, which count as "never loaded", and how assertions are counted (a rough line count). A setup approved before phase 3 has no `tests`; a Goal pinned to it runs without locked tests, and a new setup version adds them. `needsHuman` and `forbid` are read by the package gate (`APOS-SCOPE`, `APOS-INVENTORY`), also relative to the part's root.

A tool is a [catalog tool](catalog.md#a-tool) plus `when` (`always`, or `flag:<name>` for a Goal flag), `runs`, `failOn` and `threshold` (below). A trigger's `run` entries are `<part>.<layer>` or `system.<layer>` and must name a layer the setup defines. "system" is not a part name.

For `sarif` and `metric` tools, `reportExitCodes` optionally lists accepted process exit codes (default `[0]`). APOS still judges the report's findings or metric threshold; a nonzero code outside this list fails the check even when the report looks clean.

## Layers by stage

What the gate runs is decided by stage: `submit` (`package submit`), `integrate` (`integration gate`, Multi-WP) and `close` (`outcome close`). See [Layers by stage](../README.md#layers-by-stage) for the whole picture; this is the setup side.

- **`floor`** lists the layers per stage. A stage you leave out keeps its default: `submit: [L0, L1, L2]`, `integrate: [L1, L2, L3]`, `close: [L0, L1, L2, L3, L4, L5]`. L6 is a manual check, not a tool. At `submit` only the parts with a changed file run (by `root`), `system` does not; at `integrate` and `close` every part and `system` run. A floor layer that no part in scope defines is not run, and the assurance table says "không chạy ở khâu ...: setup không có công cụ cho lớp này".
- **`triggers`** pull a layer to an earlier stage: `{ when: { changed: ["src/ui/**"] }, at: submit, run: ["system.L4"] }` runs e2e at `submit` whenever a changed file matches (globs are relative to the repo root); `{ when: { goalFlag: "perf" }, at: submit, run: ["app.L5"] }` fires on a Goal flag. A trigger fires only at its own `at` stage. The triggered target keeps its own `when: flag:` condition.
- **`when: "flag:<name>"`** on a tool: it runs only when the Goal carries that flag (`flags` in the Goal, approved by the Human). A flag-gated tool that a criterion names (`benchmark`, `scan`) runs anyway: the criterion is the Goal asking.
- **`runs`** (1 to 5): how many times a test layer (`junit`, `apos-json`) is run on the delivery before it is judged (default 1), or a `metric` is measured (default 3). Results that disagree make the layer `unverifiable`: for a metric, runs on both sides of the threshold; never the best run.
- **`failOn`** (`error`, `warning`, `note`; default `error`) on a `sarif` tool: findings from this level up turn the layer red. Lower findings are counted on the assurance table, not red.
- **`threshold`** (`{ op: "<", value: 200 }`) on a `metric` tool: the setup's own bound. A Goal criterion that names the tool adds its own threshold; both must hold, so the setup can never loosen what the Goal approved. A metric tool with no threshold anywhere is `unverifiable` when it runs: put it behind a flag, or give it one.

Each tool becomes one check named `<part>.<layer>.<tool>`. A test layer (`junit`, `apos-json`) is green when no test fails that did not fail at the base and every locked test passes (at `submit` a package answers for the tests of its own criteria; at the later stages the Goal answers for all). A layer in which no test ran is `unverifiable`.

## Loosening the strict floor

The draft starts strict. To loosen it for a project, edit `forbid` (patterns) or `floor` (layers per stage) in the setup, commit, probe, approve a new version. Dropping a floor layer for one package is a per-Goal exception: `apos exception approve <goal> --kind floor-reduced --ref <package>:<stage>:<layer> --reason <why> (--by agent:<name> | --human)`; at `integrate` and `close` the ref starts with the Goal id. An agent may approve it (logged as `agent:<name>`, shown on the assurance table). It counts for every gate that runs after it is recorded, never for one that already ran.

## Changing the setup between Goals

Every change is a new version: edit, commit, probe, approve. A Goal pins the latest approved version at `goal approve` (`--setup-version <n>` pins an older approved one). A setup approved later does not change a Goal that is running. To move a Goal to the new version: `goal revise`, then `goal approve` again. `goal list` and the UI show `setup vN` or `không có setup`.

The first setup of a project is approved by the Human. Later changes (adding a tool or a layer) may be approved by an agent only on the Human's explicit say-so, with `--on-behalf "<where they agreed>"`.
