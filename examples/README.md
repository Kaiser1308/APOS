# Example Goals

Four small repos that `scripts/demo-goal.mjs` drives through the whole v3 flow with the real APOS binary and a real test runner. See [docs/demo.md](../docs/demo.md).

| Example | Stack | Goal |
| --- | --- | --- |
| `ts-orders` | TypeScript, vitest | An order placed more than 30 days ago cannot be cancelled |
| `py-parking` | Python, pytest | A slot becomes occupied when its sensor reports a car |
| `ts-bug` | TypeScript, vitest | A bug: the code `FREE0` (0% off) makes an order's total 0. Run by `npm run demo:bug` through `apos bug` |
| `py-legacy` | Python, pytest | A repo with **no tests**: approved as low assurance, `pricing.py` captured by a `characterize` Goal, then tidied by a `refactor` Goal. Run by `npm run demo:legacy` |

Each example has:

- `repo/`: the code the Goal starts from (it passes its own tests);
- `brief.md`: the source document of the Goal, verbatim;
- `goal.json`: the Goal (Given/When/Then criteria, and a `benchmark` criterion proved at the close stage);
- `plan.json`: the Lead's Solo plan (the demo adds `baseCommit`);
- `steps/*.patch`: what the people and agents commit, in the order of the story.

`ts-bug` is a bug story and has a different shape: `bug.json` (what `apos bug open` is given) in place of `brief.md` and `goal.json`, no plan file (`apos lead propose --bugfix` writes it), and these steps:

| Patch | On top of | What it is | What APOS says |
| --- | --- | --- | --- |
| `00-green-test` | the repo | A test that is green on the bug | `tests submit`: refused, "test không tái hiện lỗi" |
| `00b-code-edit` | the repo | The reproduction, and a change to the code | `tests submit`: refused, "the Tester adds tests only" |
| `01-repro-test` | the repo | The reproduction: red on the bug | `tests submit`: locked |
| `02-fix` | 01 | The fix | `package submit`: green, verified |

`py-legacy` is the old-repo story: `repo/` has no test (the demo keeps only L2 in the setup, where the captured tests go: an empty layer is red at the gate like any other; the folders `tests/acceptance/` and `tests/integration/` exist with a `.gitkeep`, because a test tool pointed at a missing folder is exit 4, not "no tests"), `brief.md` and `characterize.json` are the first Goal, `refactor-brief.md`, `refactor.json` (paths reach `shipping.py`), `refactor-v2.json` (paths narrowed to `pricing.py`) and `refactor-plan.json` the second, and these steps:

| Patch | On top of | What it is | What APOS says |
| --- | --- | --- | --- |
| `01-wrong-capture` | the repo | Tests of `pricing.py`; the one for `FREE0` asserts what the Tester thinks it should do | `tests submit`: refused, `chụp hành vi phải xanh trên code như hiện tại` |
| `02-capture` | the repo | The same tests, asserting what the code does today | `tests submit`: locked; `package submit` on that commit: green, verified |
| `03-refactor-breaks` | 02, merged | A restructuring that also "fixes" `FREE0` | `package submit`: red, `APOS-CHARACTERIZED fail` |
| `04-refactor` | 02, merged | A restructuring that keeps every behaviour | `package submit`: green, verified |

## The steps

Every patch is a `git diff` and applies with `git apply` on the commit named in the "On top of" column.

| Patch | On top of | What it is | What APOS says |
| --- | --- | --- | --- |
| `01-tests-and-stub` | the repo | The Tester's acceptance tests, the test map, and the entry as a stub that says "not implemented" | `tests submit`: locked (red for the right reason) |
| `02-locked-test-edit` | 01 | Buggy code, and the locked test weakened until it passes | `package submit`: red, `APOS-LOCKED fail: locked test modified` |
| `03-buggy-code` | 01 | Buggy code: the boundary case is wrong | `package submit`: red, the acceptance test fails |
| `04-correct-code` | 01 | Code that meets every acceptance test, but drops a rule that existed before | `package submit`: green |
| `05-review-test` | 04 | A reviewer's test of that old rule: red on 04, green on the locked stub | `review block`: blocked by review |
| `06-final-fix` | 05 | The rule is back | `package submit`: green, the review test is locked with the others |

The review test is green on the locked stub on purpose: a test that was already red before the package would only be a `pre-existing` finding and could not block it.

## By hand

```sh
cp -r examples/ts-orders/repo /tmp/orders && cd /tmp/orders
ln -s <apos>/node_modules node_modules   # or npm install
git init -q && git add -A && git commit -qm base
git apply ../path/to/examples/ts-orders/steps/01-tests-and-stub.patch && npx vitest run
```

Two notes. `ts-orders/repo/package-lock.json` is a stub with no packages: the demo links the APOS checkout's `node_modules` into the copy, and APOS only does that when the lock file is the same on both sides; run `npm install` in a copy of your own to get a real one. And run the example from a copy outside the APOS checkout (the demo does): vitest would otherwise pick up the `vitest.config.ts` of the repository above it.
