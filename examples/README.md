# Example Goals

Seven small repos that `scripts/demo-goal.mjs` drives through the whole v3 flow with the real APOS binary and a real test runner. See [docs/demo.md](../docs/demo.md).

| Example | Stack | Goal |
| --- | --- | --- |
| `ts-orders` | TypeScript, vitest | An order placed more than 30 days ago cannot be cancelled |
| `py-parking` | Python, pytest | A slot becomes occupied when its sensor reports a car |
| `ts-bug` | TypeScript, vitest | A bug: the code `FREE0` (0% off) makes an order's total 0. Run by `npm run demo:bug` through `apos bug` |
| `ts-maint` | TypeScript, vitest | A dependency upgrade that removes a finding: `fmt` 1.0.0 carries CVE-FMT-1; the Goal must reach a version without it and change nothing else. No network (the dependency is a folder in `vendor/`). Run by `npm run demo:maint` through `apos maintenance` |
| `py-legacy` | Python, pytest | A repo with **no tests**: approved as low assurance, `pricing.py` captured by a `characterize` Goal, then tidied by a `refactor` Goal. Run by `npm run demo:legacy` |
| `ts-hotfix` | TypeScript, vitest | Production is on fire: the code `FREE0` makes an order's total 0 (the `ts-bug` bug). The Human lets a fix through with `apos hotfix`; the Goal it opens must show a test red on the commit before the hotfix and green on a delivery that contains it. Run by `npm run demo:hotfix` |
| `py-remove` | Python, pytest | A feature removed: the shop drops its coupons. The Goal's `removed` criterion names the two old tests that go with them; the gate lets exactly those disappear. Run by `npm run demo:remove` |

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

`ts-maint` is the maintenance story: `repo/` pins `fmt` with `"fmt": "file:vendor/fmt-1.0.0"` and loads it from that folder (`src/fmt.ts`; a real project would just import `fmt`), `vendor/fmt-1.0.0|1.1.0|2.0.0` are the three versions (2.0.0 renames `format()` to `render()`), `tools/scan.mjs` is a scanner that prints SARIF and reports `CVE-FMT-1` while `package.json` pins 1.0.0, and `maintenance.json` is what `apos maintenance open` is given. There is no brief, no Goal file and no plan file, and no patch: the demo itself commits the three upgrades:

| Upgrade | What it is | What APOS says |
| --- | --- | --- |
| `fmt` 2.0.0 | The breaking release | `package submit`: red, four tests that were green on the base are red now |
| `fmt` 1.1.0 and an edit of `src/price.ts` | Upgrade plus a source change outside the manifests | `package submit`: red, `APOS-SCOPE` names `src/price.ts` |
| `fmt` 1.1.0 | The upgrade and nothing else | `package submit`: needs a decision (`package.json` is sensitive); an agent approves it; the same commit is green and the finding is gone |

`py-remove` is the removal story: `goal.json` has a criterion `proof: "removed"` with `removesTests` (the two tests of `tests/test_coupons.py`), `plan.json` names the files of the old tests in `paths`, and these steps:

| Patch | On top of | What it is | What APOS says |
| --- | --- | --- | --- |
| `01-absence-test` | the repo | Two tests that say coupons are gone: red while they exist | `tests submit`: locked |
| `02-removes-one-too-many` | 01 | The removal, and a test nobody declared | `package submit`: red, `test missing: ...` names it |
| `03-keeps-a-declared-test` | 01 | The removal, but a declared test is kept | `package submit`: red, `declared removed but still there` |
| `04-removal` | 01 | The removal and exactly the two declared tests | `package submit`: green, verified |

`ts-hotfix` is the hotfix story: `repo/` is the `ts-bug` repo, `hotfix.json` is what `apos hotfix` is given (the description, the Given/When/Then and `due`), there is no brief, Goal file or plan file, and these steps:

| Patch | On top of | What it is | What APOS says |
| --- | --- | --- | --- |
| `00-hotfix` | the repo (on `main`) | The fix: a code change and no test. It is the commit the Human lets through | `apos hotfix`: refused without a Human, then recorded |
| `00-green-test` | the commit before the hotfix | A test that is green on the bug | `tests submit`: refused, "test không tái hiện lỗi" |
| `01-repro-test` | the commit before the hotfix | The reproduction: red on the bug | `tests submit`: locked |
| `02-own-fix` | 01 | A fix of the Worker's own, not the hotfix | `package submit`: red, `APOS-HOTFIX fail` |
| (merge) | 01 | The hotfix merged into the Tester's commit | `package submit`: green, verified |
