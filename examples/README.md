# Example Goals

Two small repos that `scripts/demo-goal.mjs` drives through the whole v3 flow with the real APOS binary and a real test runner. See [docs/demo.md](../docs/demo.md).

| Example | Stack | Goal |
| --- | --- | --- |
| `ts-orders` | TypeScript, vitest | An order placed more than 30 days ago cannot be cancelled |
| `py-parking` | Python, pytest | A slot becomes occupied when its sensor reports a car |

Each example has:

- `repo/`: the code the Goal starts from (it passes its own tests);
- `brief.md`: the source document of the Goal, verbatim;
- `goal.json`: the Goal (Given/When/Then criteria, and a `benchmark` criterion proved at the close stage);
- `plan.json`: the Lead's Solo plan (the demo adds `baseCommit`);
- `steps/*.patch`: what the people and agents commit, in the order of the story.

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
