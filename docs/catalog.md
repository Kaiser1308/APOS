# The tool catalog

The catalog tells a Lead which tools usually fit a stack, so a project setup can be drafted instead of written from scratch. **It guarantees nothing.** Only a setup that passed `apos setup probe` and that the Human approved decides what the gate runs. The core of APOS knows no tool or language name: every name lives in `catalog/`.

## Where it lives

- Shipped with APOS: `catalog/<stack>.yaml` (python, java-gradle, java-maven, typescript).
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
assertPatterns: ['^\\s*assert\\b']
notImplementedPatterns: [NotImplementedError]
forbid: ['@pytest\\.mark\\.(?:skip|skipif|xfail)']
needsHuman: [pyproject.toml, .github/**]
```

| Field | Meaning |
| --- | --- |
| `stack` | Lowercase name; `apos setup draft --part <name>=<dir>:<stack>` uses it. |
| `detect` | A directory is this stack when every file in `files` exists and every `contains` substring is found. |
| `layers` | Tools per layer `L0` to `L5` (`L6` is a hand confirmation, never a tool). The first tool of each layer is what a draft picks. |
| `loadErrorPatterns` | Regexes matched on a failing test's message to recognise a test that never loaded (a collection or import error, a broken class). The probe fails with `tests could not load: <message>` on such a test, and also when every test in a report errored. Phase 3 reuses them to tell "red for the right reason" from "could not run". |
| `testPaths` | Globs, relative to the part's root, of the files that hold tests: what a tester may commit and what gets locked (Python `tests/**`, `**/test_*.py`; TypeScript `**/*.test.ts`, `**/*.spec.ts`, `tests/**`; Java `src/test/**`). |
| `testInfra` | Globs of test infrastructure: `conftest.py`, `pytest.ini`, `tox.ini`, `setup.cfg`, `pyproject.toml`, `**/__init__.py` (Python); `vitest.config.*`, `vite.config.*`, `jest.config.*`, `**/vitest.setup.*`, `**/setupTests.*`, `tsconfig*.json` (TypeScript); `src/test/resources/**`, build files (Java). Copied to `tests.infra` by `draft`; changing one after the lock needs a decision. |
| `assertPatterns`, `notImplementedPatterns`, `loadErrorPatterns` | Regexes that count assertions line by line (rough), recognise a stub's "not implemented", and recognise a test that never loaded. Used by `apos tests submit`. |
| `entryRule` | How to read an import in an acceptance test; see [below](#entryrule). Absent: the stack's tests are not held to the declared entries, and the assurance table says "chưa kiểm". |
| `forbid` | Regexes forbidden in added diff lines: the strict floor a draft starts with. |
| `needsHuman` | Globs of sensitive files (dependencies, build config) that need a Human. |
| `notes` | Free text: which tool versions the commands were checked against, and what was not. |

## A tool

| Field | Meaning |
| --- | --- |
| `id` | Unique within its layer. |
| `command` | Run in the part's directory, in a clean worktree. `{report}` is replaced with a path APOS provides. |
| `format` | `junit`, `sarif`, `metric`, `apos-json`, or `exit`. |
| `report` | Where the report is when the command does not use `{report}`: a path or glob relative to the part. Every file the glob matches is read and merged; no file means the report is unreadable. |
| `metric` | For `format: metric`: dotted path to the number (e.g. `metrics.mutationScore`). Omit when the file is one number. |
| `runOne` | Runs a single test, needed to prove a test can run alone; see below. |

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
