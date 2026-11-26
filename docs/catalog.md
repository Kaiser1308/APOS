# The tool catalog

The catalog tells a Lead which tools usually fit a stack, so a project setup can be drafted instead of written from scratch. **It guarantees nothing.** Only a setup that passed `apos setup probe` and that the Human approved decides what the gate runs. The core of APOS knows no tool or language name: every name lives in `catalog/`.

## Where it lives

- Shipped with APOS: `catalog/<stack>.yaml` (python, java-gradle, java-maven, typescript, go, cpp-espidf).
- Your own: `~/.apos/catalog/` (or `$APOS_HOME/catalog/`). A file whose `stack` matches a shipped one replaces it; a new `stack` is added. A file that does not parse or does not match the schema is skipped with a warning; it never hides the others.
- YAML is the preferred format. Existing `.json` catalog files are still read, and a home catalog entry overrides the bundled entry of the same stack.

## A catalog file

```yaml
stack: python
notes:
  - "verified: pytest 9.0.2 (--junitxml). Not verified: ruff, mypy, bandit."
detect:
  files: [pyproject.toml]
  contains:
    pyproject.toml: pytest
layers:
  L1:
    - id: pytest
      command: pytest --junitxml={report}
      format: junit
  L2:
    - id: pytest-acceptance
      command: pytest tests/acceptance --junitxml={report}
      format: junit
      runOne: 'pytest tests/acceptance -k "{name}" --junitxml={report}'
assertPatterns: ['^\s*assert\b']
notImplementedPatterns: [NotImplementedError]
forbid: ['@pytest\.mark\.(?:skip|skipif|xfail)']
needsHuman: [pyproject.toml, .github/**]
```

| Field | Meaning |
| --- | --- |
| `stack` | Lowercase name; `apos setup draft --part <name>=<dir>:<stack>` uses it. |
| `detect` | A directory is this stack when every file in `files` exists, at least one `anyFiles` entry exists when provided, and every `contains` substring is found. |
| `layers` | Tools per layer `L0` to `L5` (`L6` is a hand confirmation, never a tool). The first tool of each layer is what a draft picks. |
| `loadErrorPatterns` | Regexes matched on a failing test's message to recognise a test that never loaded (a collection or import error, a broken class). The probe fails with `tests could not load: <message>` on such a test, and also when every test in a report errored. Phase 3 reuses them to tell "red for the right reason" from "could not run". |
| `noTestsExitCodes`, `noTestsPatterns` | How the stack's test tool says "there is no test here": exit codes (pytest: `5`) and regexes matched on its output (vitest: `No test files found`; its exit code 1 is too common to count, a `globalSetup` that throws leaves the same empty junit report, and with the junit reporter alone vitest prints nothing: so the catalog's vitest commands add `--reporter=default` and `--outputFile.junit={report}`). Output that also matches a `loadErrorPatterns` entry is never read as "no tests": vitest prints "No test files found" even when a `globalSetup` throws, and the typescript entry lists `Unhandled Error` for that). The probe reads a layer as `no-tests` only when the tool said so *and* its report holds no test (or, with no report, only when a pattern matched): an exit code alone could be a crash. Copied to `tests` by `draft`. Empty (Java today) means the stack cannot tell, and a probe of an empty repo fails as it always did. Do not add a pattern that a usage error also prints: pytest says "no tests ran" for a missing path (exit 4) too, so python declares none. |
| `testPaths` | Globs, relative to the part's root, of the files that hold tests: what a tester may commit and what gets locked (Python `tests/**`, `**/test_*.py`; TypeScript `**/*.test.ts`, `**/*.spec.ts`, `tests/**`; Java `src/test/**`). |
| `testInfra` | Globs of test infrastructure: `conftest.py`, `pytest.ini`, `tox.ini`, `setup.cfg`, `pyproject.toml`, `**/__init__.py` (Python); `vitest.config.*`, `vite.config.*`, `jest.config.*`, `**/vitest.setup.*`, `**/setupTests.*`, `tsconfig*.json` (TypeScript); `src/test/resources/**`, build files (Java). Copied to `tests.infra` by `draft`; changing one after the lock needs a decision. |
| `assertPatterns`, `notImplementedPatterns`, `loadErrorPatterns` | Regexes that count assertions line by line (rough), recognise a stub's "not implemented", and recognise a test that never loaded. Used by `apos tests submit`. |
| `manifests` | Globs, relative to the part's root, of the manifests and lockfiles a `maintenance` Goal may change: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` (TypeScript); `pyproject.toml`, `poetry.lock`, `uv.lock`, `requirements*.txt`, `Pipfile*` (Python); `pom.xml`, `**/pom.xml` (Maven); `build.gradle*`, `settings.gradle*`, `gradle.lockfile`, `gradle/libs.versions.toml` (Gradle). Copied to the part's `manifests` by `draft`. Optional: a stack without it has no maintenance Goal, and `lead propose --maintenance` says so. |
| `entryRule` | How to read an import in an acceptance test; see [below](#entryrule). Absent: the stack's tests are not held to the declared entries, and the assurance table says "chưa kiểm". |
| `forbid` | Regexes forbidden in added diff lines: the strict floor a draft starts with. |
| `needsHuman` | Globs of sensitive files (dependencies, build config) that need a Human. |
| `notes` | Free text: which tool versions the commands were checked against, and what was not. |

## A tool

### Go and ESP-IDF host projects

Go detection uses `go.mod`; ESP-IDF detection accepts either `idf_component.yml` or `sdkconfig`. As with the other stacks, draft examines the root and one level of child directories. A root that also matches while child parts exist is reported as a note; select it explicitly with `--part` if needed. The Go manifests are `go.mod` and `go.sum`; the ESP-IDF manifests are `idf_component.yml` and `dependencies.lock`.

The Go runner needs the Go toolchain and `gotestsum`. APOS ships a Go-standard-library adapter invoked through `{apos}`, the APOS installation directory. It uses `go list` and the Go parser to map gotestsum's package identities to `file::name`, and refuses a test that cannot be mapped uniquely or whose source is a symlink. It indexes Go tests, examples and fuzz seeds. `runOne` selects the exact test and reports only that test, including for subtests. Build tags follow the Go toolchain environment. An empty suite is labelled `no-tests` only when the adapter exits successfully and writes a readable empty report; matching `[no test files]` alone would conceal a failure in another package. Build errors and missing tools do not become empty success. Verified locally with Go 1.27.4 and gotestsum 1.13.0. The catalog also suggests `staticcheck` and `govulncheck`; they were not available for verification. `go vet` was run locally. The `go run` adapter must be shipped alongside APOS in `scripts/go-junit/`.

The Go entry rule uses the Go parser and checks all committed non-test `.go` files of an imported package against the declared entries. It also checks same-package access and follows imports in same-package test helpers and imported test-helper packages; those helper files are locked with the tests. Helper selection follows the Go build context for the bundled runner; when custom `GOFLAGS` or a custom L2 command are present it conservatively checks all candidate helpers instead of guessing their active tags. Imported production packages are also checked conservatively across build tags. It fails closed if the parser or module cannot be read, an import cannot be resolved, or a Go workspace, nested module, `replace`, cgo, `unsafe`, or `go:linkname` is encountered. This is static import checking, not a sandbox against arbitrary test code. External imports and standard-library imports outside the module path are not treated as local packages.

The ESP-IDF entry uses a project-provided host CMake/CTest suite; each test command configures and builds in its own worktree before producing JUnit, so it needs CMake, CTest and a C++ compiler but no device. It selects the `Debug` configuration for multi-config generators. Verified locally with CMake/CTest 4.2.3 and a single-config generator; the full Ninja Multi-Config probe is skipped when Ninja is unavailable. CTest's JUnit report identifies the CTest name but does not identify its source file: although the setup probe works, `tests submit` cannot lock a test whose source cannot be identified from its report. A project needs a reporter that supplies an unambiguous test file for that flow. `idf.py build` is an alternative L0 command, not verified here; ESP-IDF, clang-tidy and cppcheck were not installed, so no SARIF command for them is claimed. Hardware testing remains a manual L6 confirmation, not a host test. Host CTest must be configured by each firmware project and does not establish firmware or hardware correctness.

Offline examples are in `examples/go-calc` and `examples/cpp-espidf-host`. Copy either into a Git repository, run `apos init`, `apos setup draft`, review the setup, commit it, then run `apos setup probe`. The Go draft includes L5 `govulncheck`; install and configure that tool separately or remove L5 from the draft when experimenting offline, before committing and probing. The ESP-IDF example's host suite needs only CMake/CTest and a C++ compiler. The conditional e2e tests name the missing prerequisites when they are skipped in Vitest output; they do not turn an unavailable tool into a passing probe.

| Field | Meaning |
| --- | --- |
| `id` | Unique within its layer. |
| `command` | Run in the part's directory, in a clean worktree. `{report}` is replaced with a path APOS provides; place it inside double quotes to support paths with spaces. |
| `format` | `junit`, `sarif`, `metric`, `apos-json`, or `exit`. |
| `report` | Where the report is when the command does not use `{report}`: a path or glob relative to the part. Every file the glob matches is read and merged; no file means the report is unreadable. |
| `reportExitCodes` | Optional exit codes accepted when reading a `sarif` or `metric` report (default `[0]`). The report still decides findings or threshold status. Set this for tools that intentionally return a nonzero status while writing a usable report. |
| `metric` | For `format: metric`: dotted path to the number (e.g. `metrics.mutationScore`). Omit when the file is one number. |
| `runOne` | Runs a single test, needed to prove a test can run alone; see below. |
| `testFileRequired` | When true, a test can be locked only when the report supplies a `file` that matches a committed test path. If any tool in a layer sets it, it applies to the layer. The probe warns if a reported test lacks a file; a passing probe does not establish that a reporter's file attribution is truthful. |

`{apos}` expands to the APOS installation directory; place it inside double quotes, as in `"{apos}/scripts/go-junit/main.go"`. The adapter is part of the APOS installation, not a file from the project under test.

### `runOne` placeholders

The probe takes the first test of the full run that did not skip and fills the template with it. The probe passes only if the run reports exactly one test that did not skip, with the same id (a runner may list the others as skipped).

| Placeholder | Value |
| --- | --- |
| `{id}` | The whole test id, `<classname>::<name>`. |
| `{classname}`, `{name}` | Its two halves, split at the first `::`. |
| `{file}` | The `file` attribute of the testcase, when the runner writes one (pytest needs `-o junit_family=xunit1`). The probe fails with that hint when `{file}` is used and the report has none. |
| `{within}` | The class segments between the file's module path and the test name, as `Class::Inner::`, or empty: `{file}::{within}{name}` is a pytest node id for a function or a method. |

A modifier changes the value before it is quoted: `{name|regex}` escapes regex characters, `{name|spaced}` turns ` > ` (how vitest joins describe names in a report) into a space, `{name|noparens}` drops a trailing `(...)` (JUnit 5 names), and modifiers chain left to right: vitest uses `-t "^{name|spaced|regex}$"` to match one test by its exact full name, nested `describe` included. After the modifiers the value is escaped for a double-quoted shell string (quotes, backslashes, and off Windows `$` and backticks), so put the placeholder inside double quotes. An unknown placeholder or modifier makes the catalog file invalid.

### The result formats

- **junit**: JUnit XML. A test id is `<classname>::<name>`, or `<file or suite name>::<name>` without a classname; a repeated id gets `#2`, `#3` in report order. `<error>` is `error`, `<failure>` is `fail`. Read by `src/domain/results/junit.ts`.
- **sarif**: SARIF 2.1.0 findings (`ruleId`, `level`, `file`, `line`). A run without a `results` array is unreadable, not clean.
- **metric**: one number.
- **apos-json**: `{"tests":[{"id","status":"pass|fail|error|skip","message?"}]}` or `{"findings":[{"ruleId","level","file?","line?"}]}`.
- **exit**: for tools with no report (a type checker, a compile step). Pass or fail by exit code only, no test ids. A setup shows these as "only the exit code": nothing is compared base against delivery.

A missing, empty or broken report is `unverifiable`, never "0 tests, green".

## Adding a stack or a tool

1. Copy a shipped file to `~/.apos/catalog/<stack>.yaml` and edit it. Keep the commands in the form the tool really takes: run them once by hand.
2. If the tool cannot write one of the formats, write a small script that runs it and writes `apos-json`, and use the script as the tool's `command`. Write it once and reuse it for every project.
3. Run `apos setup draft`, edit the result, commit it, then `apos setup probe` (see [setup.md](setup.md)). The probe is what proves a command on a real project.

Commands that Gradle or Maven run need care: Gradle skips an up-to-date `test`, so the shipped commands use `cleanTest test`; both write a directory of XML files, so they set `report` to a glob.


## Mutation

A tool with `"when": "flag:mutation"`, `"format": "metric"` and a `metric` path (`mutationScore`) is the mutation tool of its stack: it runs at the close stage for a Goal approved with `--flag mutation`, and the core reads only the number. `{changed}` in its command is the changed source files, comma-separated, so only new code is mutated. The score is on a 0 to 100 scale; the floor is `mutation.minScore` of the setup (70).

| Stack | Tool | How the score is made |
| --- | --- | --- |
| typescript | Stryker (`npx stryker run --mutate`) | the JSON reporter writes `reports/mutation/mutation.json`; a one-line `node -e` turns it into `killed + timeout` over the mutants that ran |
| python | mutmut 2.x | `mutmut export-cicd-stats` writes `mutmut-cicd-stats.json`; a one-line `python -c` turns it into `killed / total` |
| java | PIT | not shipped: PIT writes XML with no score. Write a small script that runs it and writes `{"mutationScore": n}`, and use the script as the command (see [Adding a stack or a tool](#adding-a-stack-or-a-tool)) |

Neither shipped command has been run on a real project here (see `notes`): the probe is what proves them, and it runs the tool once on one source file of the part.

## AI tools

An AI tool (a model that writes tests, hunts for bugs or reviews a diff) is never a judge: APOS trusts only a command that runs the same way every time and a report it can read. So an AI tool enters the system through the doors that already exist, and nothing it says gets a vote:

| The tool does | It reaches APOS as | Judged by |
| --- | --- | --- |
| Writes acceptance, integration or end-to-end tests | a commit sent with `apos tests submit` (or `apos tests revise` for a locked suite), like a Tester's | the same checks: the tests load, are red for the right reason on the stub, are stable over two runs |
| Finds a bug in a delivery | a test in a review commit, sent with `apos review block` | APOS runs that test; only a red test for a code reason blocks, and it is locked into the next delivery |
| Reviews a diff in words | `apos review note` | nothing: it is advice |
| Is wired in as a layer tool in a setup (it writes `apos-json` or `junit`) | a tool of the project's setup | `apos setup probe`: it runs twice on L1 and L2 and the two results must be the same |

The last row is the safeguard against a tool that gives a different answer each time: the probe fails with `two runs gave different results (flaky)` and the setup cannot be approved. If you want a model's output as a layer, fix it first: pin the seed and temperature, or have the model write test files once, commit them, and let a normal runner run them.

## `entryRule`

A test may call the code only through the entries the plan declares (`stubPaths`). The catalogue says how to see what a test imports; the core knows no language.

| Field | Meaning |
| --- | --- |
| `importPatterns` | An array of regexes tried on each line of an L2 test file, anchored on the statement (so a comment or a sentence that says "from" matches nothing). Group 1 is the module (several, comma separated, for Python `import a, b`); the optional group 2 is the names of a `from <module> import <names>`: a name that is a submodule of the module is judged as that submodule, any other name as a symbol of the module itself. |
| `allowImports` | Regexes on the module text: libraries and the standard library, never judged. A module that does not exist as a file in the repo is not judged either, so this list only matters for a repo file that shadows a library. |
| `moduleSeparator` | `.` (Python) or `/` (TypeScript): what separates the parts of a module path. A leading `.` is relative to the test file. |
| `moduleFiles` | The files a module may be, `{path}` standing for its path with `/`: `{path}.py`, `{path}/__init__.py`; `{path}.ts`, `{path}/index.ts`. |
| `stripExtension` | A regex removed from the end of an import first (`.js` in TypeScript's `./calc.js`). |

An import that resolves to a file of the repo is allowed when that file matches a declared `stubPaths` glob or the part's `tests.paths`; otherwise `tests submit` (and `tests revise`) refuse it with `<file>:<line>: imports "<module>" (<path>), an internal module that is not a declared entry`. The rule reads import statements line by line: a dynamic import, a call through a re-export, a `from x import (` list that spans several lines, or a statement inside a string or block comment is not read right. Java has no rule yet.
