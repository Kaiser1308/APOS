# The tool catalog

The catalog tells a Lead which tools usually fit a stack, so a project setup can be drafted instead of written from scratch. **It guarantees nothing.** Only a setup that passed `apos setup probe` and that the Human approved decides what the gate runs. The core of APOS knows no tool or language name: every name lives in `catalog/`.

## Where it lives

- Shipped with APOS: `catalog/<stack>.json` (python, java-gradle, java-maven, typescript).
- Your own: `~/.apos/catalog/` (or `$APOS_HOME/catalog/`). A file whose `stack` matches a shipped one replaces it; a new `stack` is added. A file that does not parse or does not match the schema is skipped with a warning; it never hides the others.

The file format is the one the build injects as `SetupCodec` (JSON today; see [setup.md](setup.md#switching-to-yaml)).

## A catalog file

```json
{
  "stack": "python",
  "notes": ["verified: pytest 9.0.2 (--junitxml). Not verified: ruff, mypy, bandit."],
  "detect": { "files": ["pyproject.toml"], "contains": { "pyproject.toml": "pytest" } },
  "layers": {
    "L1": [{ "id": "pytest", "command": "pytest --junitxml={report}", "format": "junit" }],
    "L2": [
      {
        "id": "pytest-acceptance",
        "command": "pytest tests/acceptance --junitxml={report}",
        "format": "junit",
        "runOne": "pytest tests/acceptance -k \"{name}\" --junitxml={report}"
      }
    ]
  },
  "assertPatterns": ["^\\s*assert\\b"],
  "notImplementedPatterns": ["NotImplementedError"],
  "forbid": ["@pytest\\.mark\\.(?:skip|skipif|xfail)"],
  "needsHuman": ["pyproject.toml", ".github/**"]
}
```

| Field | Meaning |
| --- | --- |
| `stack` | Lowercase name; `apos setup draft --part <name>=<dir>:<stack>` uses it. |
| `detect` | A directory is this stack when every file in `files` exists and every `contains` substring is found. |
| `layers` | Tools per layer `L0` to `L5` (`L6` is a hand confirmation, never a tool). The first tool of each layer is what a draft picks. |
| `assertPatterns`, `notImplementedPatterns` | Regexes for phase 3 (counting assertions, recognising "not implemented yet"). Prepared here, not used yet. |
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
| `runOne` | Runs a single test, needed to prove a test can run alone. `{id}` is the whole test id (`<classname>::<name>`); `{classname}` and `{name}` are its halves, split at the first `::`. Quotes, backslashes, `$` and backticks in the value are escaped for a double-quoted context. |

### The result formats

- **junit**: JUnit XML. A test id is `<classname>::<name>`, or `<file or suite name>::<name>` without a classname; a repeated id gets `#2`, `#3` in report order. `<error>` is `error`, `<failure>` is `fail`. Read by `src/domain/results/junit.ts`.
- **sarif**: SARIF 2.1.0 findings (`ruleId`, `level`, `file`, `line`). A run without a `results` array is unreadable, not clean.
- **metric**: one number.
- **apos-json**: `{"tests":[{"id","status":"pass|fail|error|skip","message?"}]}` or `{"findings":[{"ruleId","level","file?","line?"}]}`.
- **exit**: for tools with no report (a type checker, a compile step). Pass or fail by exit code only, no test ids. A setup shows these as "only the exit code": nothing is compared base against delivery.

A missing, empty or broken report is `unverifiable`, never "0 tests, green".

## Adding a stack or a tool

1. Copy a shipped file to `~/.apos/catalog/<stack>.json` and edit it. Keep the commands in the form the tool really takes: run them once by hand.
2. If the tool cannot write one of the formats, write a small script that runs it and writes `apos-json`, and use the script as the tool's `command`. Write it once and reuse it for every project.
3. Run `apos setup draft`, edit the result, commit it, then `apos setup probe` (see [setup.md](setup.md)). The probe is what proves a command on a real project.

Commands that Gradle or Maven run need care: Gradle skips an up-to-date `test`, so the shipped commands use `cleanTest test`; both write a directory of XML files, so they set `report` to a glob.
