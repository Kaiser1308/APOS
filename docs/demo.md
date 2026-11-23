# Demo: six example stories, run for real

`npm run demo:ts`, `npm run demo:py`, `npm run demo:bug`, `npm run demo:maint`, `npm run demo:legacy` and `npm run demo:remove` copy an example from `examples/` to a temp directory, `git init` it and drive the **real** APOS binary (`dist/cli.js`, so run `npm run build` first) with a real test runner (vitest, pytest). Every step prints the command, its exit code and what APOS said, and checks the exit code it expected; a surprise exits 1. A machine without a tool the example needs (`git`, `npx`/vitest, `python`/pytest) stops at once with exit 2 and names it: the script never reports a pass it did not see. `--keep` leaves the temp directory in place. See `examples/README.md` for the files of an example.

The story, in order: setup draft, probe, approve; Goal create, approve, select; the Lead proposes and commits a plan; the Tester submits the acceptance tests (locked); a delivery that edits a locked test is red; a delivery with wrong code is red; the right code is green; a reviewer blocks with a red test; the final fix (the review's test is now locked and green) is green; the Human closes the Goal; `goal show` prints the assurance table.

## TypeScript (`ts-orders`: an order older than 30 days cannot be cancelled)

`npm run demo:ts`, output as printed:

```text
demo ts-orders: working in <tmp> (a temp directory; --keep leaves it)

# init the project
$ apos init  # exit 0
Initialized <repo>

# draft the setup from the catalog
$ apos setup draft  # exit 0
Wrote .apos/project.yaml: app
Not committed. Edit it, commit it, then: apos setup probe --commit <sha>

# probe every tool of the setup in a clean worktree
$ apos setup probe --commit 8fb0c31bf4  # exit 0
ok   app.L1 vitest: 3 tests, stable over 2 runs
ok   app.L2 vitest-acceptance: 1 tests, runOne ok, stable over 2 runs
ok   app.L3 vitest-integration: 1 tests, runOne ok
ok   app.L5 bench: metric
ok   app.tests patterns: 11 patterns compile; tests under **/*.test.ts, **/*.spec.ts, tests/**
setup 3d776992da34 at 8fb0c31bf428: probe passed

# the Human approves the probed setup
$ apos setup approve --commit 8fb0c31bf4 --on-behalf demo  # exit 0
Approved setup v1 (3d776992da34) at 8fb0c31bf428

# the PM drafts the Goal from the brief
$ apos goal create --file /home/kaiser/orca/workspaces/APOS/v3-dot5/examples/ts-orders/goal.json --source /home/kaiser/orca/workspaces/APOS/v3-dot5/examples/ts-orders/brief.md  # exit 0
Drafted GOAL-001

# the Human approves the Goal and its appetite
$ apos goal approve GOAL-001 --size M --max-minutes 240 --max-attempts 5 --on-behalf demo  # exit 0
Approved GOAL-001 on setup v1

# the Human selects it
$ apos goal select GOAL-001 --on-behalf demo  # exit 0
Selected GOAL-001

# the Lead proposes a Solo plan
$ apos lead propose --file /tmp/apos-demo-ts-orders-vKF9nn/work/plan.json  # exit 0
Proposed EXEC-001

# the Lead commits the plan: the Goal waits for locked tests
$ apos lead commit GOAL-001  # exit 0
Accepted GOAL-001. Next the tester writes the acceptance tests and stubs: `apos tests submit GOAL-001 --commit <sha>`. Packages open once they are locked.

# the Tester hands over acceptance tests and a stub: red for the right reason, so they are locked
$ apos tests submit GOAL-001 --commit 1c5805779c  # exit 0
Locked 3 tests in 1 files on 1c5805779c78a671674cc551d0bfb1a811ebb896. Packages are gated on top of this commit.

# a Worker makes the test pass by weakening it: red
$ apos package submit GOAL-001 WP-MAIN --commit 0419f03ee9  # exit 1
WP-MAIN red on 0419f03ee9c5e1da11d6910b3054cd8e84a37a1f
  APOS-LOCKED fail: locked test modified: src/cancel.acceptance.test.ts; AC-2 app.L2 src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled: not in the delivery report
  APOS-INVENTORY fail: test missing: app.L2::src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled
  app.L2.vitest-acceptance fail: app.L2 vitest-acceptance: locked test src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled is not in the report, not pass
  needs attention: declared risks: The old shipped-order rule lives in the same function and has no test

# a Worker delivers code with a bug: the locked test is red
$ apos package submit GOAL-001 WP-MAIN --commit 38a80d4bc3  # exit 1
WP-MAIN red on 38a80d4bc3efa9032e97b033d27ee4fc40dc2f63
  CHK-1 fail: exit 1 on delivery
  APOS-LOCKED fail: AC-2 app.L2 src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled: is fail, not pass
  app.L2.vitest-acceptance fail: app.L2 vitest-acceptance: locked test src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled is fail, not pass
  needs attention: declared risks: The old shipped-order rule lives in the same function and has no test

# a Worker delivers code that meets every acceptance test: green, the Goal is verified
$ apos package submit GOAL-001 WP-MAIN --commit 1caa424616  # exit 0
WP-MAIN green on 1caa4246167c0cbaf325135e3aeb12b75e18d0c5; GOAL-001 verified
  needs attention: declared risks: The old shipped-order rule lives in the same function and has no test

# a Reviewer finds what the tests missed and says it with a test: it is red, so the package is blocked
$ apos review block GOAL-001 WP-MAIN --commit 608c51718b --by reviewer  # exit 1
WP-MAIN blocked by review on 608c51718b03a1ad62f4300638305d9f47379e30: blocked by review: src/cancel.review.test.ts::a shipped order is never reported as cancelled
  1 test(s) are now locked into the next delivery. Build the fix on 608c51718b03a1ad62f4300638305d9f47379e30.

# the final fix, built on the review commit: its test is locked and passes
$ apos package submit GOAL-001 WP-MAIN --commit b059a47a5a  # exit 0
WP-MAIN green on b059a47a5aad047ea4ee389878be1ea4bcdea155; GOAL-001 verified
  needs attention: declared risks: The old shipped-order rule lives in the same function and has no test

# the Human closes the Goal: the close-stage layers (the benchmark among them) run on the verified commit
$ apos outcome close GOAL-001 --on-behalf demo  # exit 0
Close-stage layers green on b059a47a5aad047ea4ee389878be1ea4bcdea155
close GOAL-001

# the assurance table: what the machine proved, and what it did not
$ apos goal show GOAL-001  # exit 0
GOAL-001	closed	An order placed more than 30 days ago cannot be cancelled
setup v1
khoá test: commit 1c5805779c78a671674cc551d0bfb1a811ebb896, 3 test, 1 file, 4 assert (đếm dòng, chỉ gần đúng)

GOAL-001  setup v1  (app: typescript)
  Tiêu chí           3   máy chứng minh 3 · anh xác nhận tay 0
  Test đã khoá       L2 3
  Kiểm kê / phạm vi  bật
  Lớp khâu submit    WP-MAIN: L1 vitest ✓ · L2 vitest-acceptance ✓
  Lớp khâu đóng      L1 vitest ✓ · L2 vitest-acceptance ✓ · L3 vitest-integration ✓ · L5 bench ✓ (p99 0.3081)
  Review chặn        1 lần bằng test đỏ, 1 test đã khoá vào lần giao sau
  Agent duyệt thay   0 chỗ
  Tắt / chưa kiểm    L0 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L0 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L4 không chạy ở khâu close: setup không có công cụ cho lớp này

demo ts-orders: every step ended as expected.
```

## Python (`py-parking`: a parking spot becomes occupied when the sensor says so)

`npm run demo:py`, output as printed:

```text
demo py-parking: working in <tmp> (a temp directory; --keep leaves it)

# init the project
$ apos init  # exit 0
Initialized <repo>

# draft the setup from the catalog
$ apos setup draft  # exit 0
Wrote .apos/project.yaml: app
Not committed. Edit it, commit it, then: apos setup probe --commit <sha>

# probe every tool of the setup in a clean worktree
$ apos setup probe --commit 9db67e6f58  # exit 0
ok   app.L1 pytest: 3 tests, stable over 2 runs
ok   app.L2 pytest-acceptance: 1 tests, runOne ok, stable over 2 runs
ok   app.L3 pytest-integration: 1 tests, runOne ok
ok   app.L5 bench: metric
ok   app.tests patterns: 10 patterns compile; tests under tests/**, **/test_*.py, **/*_test.py
setup e75d73087f33 at 9db67e6f5801: probe passed

# the Human approves the probed setup
$ apos setup approve --commit 9db67e6f58 --on-behalf demo  # exit 0
Approved setup v1 (e75d73087f33) at 9db67e6f5801

# the PM drafts the Goal from the brief
$ apos goal create --file /home/kaiser/orca/workspaces/APOS/v3-dot5/examples/py-parking/goal.json --source /home/kaiser/orca/workspaces/APOS/v3-dot5/examples/py-parking/brief.md  # exit 0
Drafted GOAL-001

# the Human approves the Goal and its appetite
$ apos goal approve GOAL-001 --size M --max-minutes 240 --max-attempts 5 --on-behalf demo  # exit 0
Approved GOAL-001 on setup v1

# the Human selects it
$ apos goal select GOAL-001 --on-behalf demo  # exit 0
Selected GOAL-001

# the Lead proposes a Solo plan
$ apos lead propose --file /tmp/apos-demo-py-parking-7VhRjx/work/plan.json  # exit 0
Proposed EXEC-001

# the Lead commits the plan: the Goal waits for locked tests
$ apos lead commit GOAL-001  # exit 0
Accepted GOAL-001. Next the tester writes the acceptance tests and stubs: `apos tests submit GOAL-001 --commit <sha>`. Packages open once they are locked.

# the Tester hands over acceptance tests and a stub: red for the right reason, so they are locked
$ apos tests submit GOAL-001 --commit 8d97e96e13  # exit 0
Locked 3 tests in 1 files on 8d97e96e13307f40ac11164d491c4708902691e1. Packages are gated on top of this commit.

# a Worker makes the test pass by weakening it: red
$ apos package submit GOAL-001 WP-MAIN --commit 54d19ae3d3  # exit 1
WP-MAIN red on 54d19ae3d36971f780fa14ea11dbae1c1f57c36c
  APOS-LOCKED fail: locked test modified: tests/acceptance/test_sensor.py
  needs attention: declared risks: The old rule about reserved slots lives in the same function and has no test

# a Worker delivers code with a bug: the locked test is red
$ apos package submit GOAL-001 WP-MAIN --commit 9cb5838cf7  # exit 1
WP-MAIN red on 9cb5838cf727eb9544f842ce297c6f2c35cead4c
  CHK-1 fail: exit 1 on delivery
  APOS-LOCKED fail: AC-2 app.L2 tests.acceptance.test_sensor::test_ac2_a_reserved_slot_becomes_occupied_when_the_booked_car_arrives: is fail, not pass
  app.L2.pytest-acceptance fail: app.L2 pytest-acceptance: locked test tests.acceptance.test_sensor::test_ac2_a_reserved_slot_becomes_occupied_when_the_booked_car_arrives is fail, not pass
  needs attention: declared risks: The old rule about reserved slots lives in the same function and has no test

# a Worker delivers code that meets every acceptance test: green, the Goal is verified
$ apos package submit GOAL-001 WP-MAIN --commit 17ec8ee7a6  # exit 0
WP-MAIN green on 17ec8ee7a659366fd33299b150057a3a06258a65; GOAL-001 verified
  needs attention: declared risks: The old rule about reserved slots lives in the same function and has no test

# a Reviewer finds what the tests missed and says it with a test: it is red, so the package is blocked
$ apos review block GOAL-001 WP-MAIN --commit 2b0166b704 --by reviewer  # exit 1
WP-MAIN blocked by review on 2b0166b704d79229bc5371d3340bc1008e837c44: blocked by review: tests.test_sensor_review::test_a_reservation_is_never_freed_by_an_empty_reading
  1 test(s) are now locked into the next delivery. Build the fix on 2b0166b704d79229bc5371d3340bc1008e837c44.

# the final fix, built on the review commit: its test is locked and passes
$ apos package submit GOAL-001 WP-MAIN --commit c37be0926f  # exit 0
WP-MAIN green on c37be0926f51dd2c0c25d2747fc235780829543c; GOAL-001 verified
  needs attention: declared risks: The old rule about reserved slots lives in the same function and has no test

# the Human closes the Goal: the close-stage layers (the benchmark among them) run on the verified commit
$ apos outcome close GOAL-001 --on-behalf demo  # exit 0
Close-stage layers green on c37be0926f51dd2c0c25d2747fc235780829543c
close GOAL-001

# the assurance table: what the machine proved, and what it did not
$ apos goal show GOAL-001  # exit 0
GOAL-001	closed	A slot becomes occupied when its sensor reports a car
setup v1
khoá test: commit 8d97e96e13307f40ac11164d491c4708902691e1, 3 test, 1 file, 3 assert (đếm dòng, chỉ gần đúng)

GOAL-001  setup v1  (app: python)
  Tiêu chí           3   máy chứng minh 3 · anh xác nhận tay 0
  Test đã khoá       L2 3
  Kiểm kê / phạm vi  bật
  Lớp khâu submit    WP-MAIN: L1 pytest ✓ · L2 pytest-acceptance ✓
  Lớp khâu đóng      L1 pytest ✓ · L2 pytest-acceptance ✓ · L3 pytest-integration ✓ · L5 bench ✓ (p95_ms 0.18)
  Review chặn        1 lần bằng test đỏ, 1 test đã khoá vào lần giao sau
  Agent duyệt thay   0 chỗ
  Tắt / chưa kiểm    L0 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L0 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L4 không chạy ở khâu close: setup không có công cụ cho lớp này

demo py-parking: every step ended as expected.
```


## A bug (`ts-bug`: the code `FREE0`, 0% off, makes an order's total 0)

`npm run demo:bug` tells a different story: no Goal file, no plan file. `bug open` and `bug approve` replace `goal create`, `approve`, `select` and the plan; two Tester commits that do not reproduce the bug are refused (one is green on the bug, one also edits the code); then the usual flow. The story: setup; `bug open`; the inbox shows `apos bug approve`; the Human approves in one command; `lead propose --bugfix` and `lead commit`; the two refusals; the reproduction is locked; the fix is green; close; the assurance table says which test reproduced the bug. Output as printed:

```text
demo ts-bug: working in <tmp> (a temp directory; --keep leaves it)

# init the project
$ apos init  # exit 0
Initialized <repo>

# draft the setup from the catalog
$ apos setup draft  # exit 0
Wrote .apos/project.yaml: app
Not committed. Edit it, commit it, then: apos setup probe --commit <sha>

# probe every tool of the setup in a clean worktree
$ apos setup probe --commit 2b5d805a53  # exit 0
ok   app.L1 vitest: 2 tests, stable over 2 runs
ok   app.L2 vitest-acceptance: 1 tests, runOne ok, stable over 2 runs
ok   app.L3 vitest-integration: 1 tests, runOne ok
ok   app.tests patterns: 11 patterns compile; tests under **/*.test.ts, **/*.spec.ts, tests/**
setup b62a0e8889b0 at 2b5d805a53a3: probe passed

# the Human approves the probed setup
$ apos setup approve --commit 2b5d805a53 --on-behalf demo  # exit 0
Approved setup v1 (b62a0e8889b0) at 2b5d805a53a3

# the PM opens a bugfix Goal from what was seen
$ apos bug open An order's total is 0 when the customer types the code FREE0, a code that gives 0% off --given a cart of 40 and the discount code FREE0 (0% off) --when the total of the order is computed --then the total is 40: a 0% code takes nothing off --repro-hint src/orders.ts  # exit 0
Drafted GOAL-BUG-001 (bugfix)
Next: the Human runs `apos bug approve GOAL-BUG-001`

# it waits for the Human in the inbox
$ apos inbox  # exit 0
GOAL-BUG-001	awaiting-approval	gates A and B in one go: apos bug approve GOAL-BUG-001

# the Human approves, sets the default appetite and selects, in one command
$ apos bug approve GOAL-BUG-001 --on-behalf demo  # exit 0
Approved and selected GOAL-BUG-001 on setup v1 (S, 60 min, 3 attempts)
Next: the Lead plans it with `apos lead propose --bugfix --goal GOAL-BUG-001`

# the Lead plans it: one Solo package, base is the current HEAD
$ apos lead propose --bugfix --goal GOAL-BUG-001  # exit 0
Proposed EXEC-BUG-001

# the Lead commits the plan: the Goal waits for the reproduction test
$ apos lead commit GOAL-BUG-001  # exit 0
Accepted GOAL-BUG-001. Next the tester writes the acceptance tests and stubs: `apos tests submit GOAL-BUG-001 --commit <sha>`. Packages open once they are locked.

# a Tester hands over a test that is green on the bug: it does not reproduce it, so it is refused
$ apos tests submit GOAL-BUG-001 --commit f9db211021  # exit 1
tests refused on f9db211021f5e2a4010bc31f44babdcc3c54ca56: nothing is locked
  AC-1 app.L2 src/orders.acceptance.test.ts::AC-1: the code FREE0 takes nothing off the total: the test does not reproduce the bug (test không tái hiện lỗi): it is already green on the current code. Make it fail on the bug, for the reason in the bug report

# a Tester who also edits the code is refused: only tests may change, so red here is red on the base
$ apos tests submit GOAL-BUG-001 --commit 3f159b6c85  # exit 1
tests refused on 3f159b6c85cd42a14ebe7c9db10487436632bc86: nothing is locked
  src/orders.ts: bugfix: the Tester adds tests only (tests.paths and tests.json), never code, a stub or test infrastructure: the bug must be red on the code as it is
  AC-1 app.L2 src/orders.acceptance.test.ts::AC-1: the code FREE0 takes nothing off the total: the test does not reproduce the bug (test không tái hiện lỗi): it is already green on the current code. Make it fail on the bug, for the reason in the bug report

# the Tester hands over a test that fails on the bug as it is (only tests changed): it is locked
$ apos tests submit GOAL-BUG-001 --commit ea72a7f506  # exit 0
Locked 1 tests in 1 files on ea72a7f506e8d2db063122719ca624a5afdaa6cf. Packages are gated on top of this commit.

# the Worker delivers the fix: the locked test is green, the Goal is verified
$ apos package submit GOAL-BUG-001 WP-MAIN --commit ffa5865219  # exit 0
WP-MAIN green on ffa5865219ef7252ae1027d389804fd12281952b; GOAL-BUG-001 verified
  needs attention: declared risks: The test passes for another reason than the bug, or the fix reaches past the bug

# the Human closes the Goal on the commit that passed the gate
$ apos outcome close GOAL-BUG-001 --on-behalf demo  # exit 0
Close-stage layers green on ffa5865219ef7252ae1027d389804fd12281952b
close GOAL-BUG-001

# the assurance table says which test reproduced the bug, red before and green after
$ apos goal show GOAL-BUG-001  # exit 0
GOAL-BUG-001	closed	An order's total is 0 when the customer types the code FREE0, a code that gives 0% off
setup v1
khoá test: commit ea72a7f506e8d2db063122719ca624a5afdaa6cf, 1 test, 1 file, 1 assert (đếm dòng, chỉ gần đúng)

GOAL-BUG-001  setup v1  (app: typescript)
  Tiêu chí           1   máy chứng minh 1 · anh xác nhận tay 0
  Test đã khoá       L2 1
  Kiểm kê / phạm vi  bật
  Lớp khâu submit    WP-MAIN: L1 vitest ✓ · L2 vitest-acceptance ✓
  Lớp khâu đóng      L1 vitest ✓ · L2 vitest-acceptance ✓ · L3 vitest-integration ✓
  Lỗi                lỗi được tái hiện bằng test app.L2::src/orders.acceptance.test.ts::AC-1: the code FREE0 takes nothing off the total: đỏ trên ed17be4, xanh trên ffa5865
  Duyệt              duyệt gộp bằng bug approve (on-behalf:demo)
  Agent duyệt thay   0 chỗ
  Tắt / chưa kiểm    L0 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L0 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L4 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L5 không chạy ở khâu close: setup không có công cụ cho lớp này

demo ts-bug: every step ended as expected.
```

## An old repo with no tests (`py-legacy`: capture what `pricing.py` does today, then tidy it)

`npm run demo:legacy` tells the story of a repo that has **no test at all** (`pricing.py`, with a minimum charge and a code `FREE0` that makes an order free; `shipping.py`, which nothing captures). It needs `pytest` and `python`. The story: the probe reads the test layer as `no-tests` (the demo's setup keeps only L2, where the captured tests go: a layer with no tests is red at the gate like any other, label or not, so a legacy setup lists only the layers that have tests to run); the Human's `setup approve` is refused until it says `--baseline-missing`; a `characterize` Goal captures `pricing.py` (a Tester's test that is red on today's code is refused, the green one is locked, the Lead submits the commit that locked it, the Human closes); a `refactor` Goal whose `paths` reach `shipping.py` cannot be approved, and the one on `pricing.py` can; a refactor that "fixes" `FREE0` is red on `APOS-CHARACTERIZED`, one that only restructures is green; close; `goal show`. Output as printed:

```text
demo py-legacy: working in <tmp> (a temp directory; --keep leaves it)

# init the project
$ apos init  # exit 0
Initialized <repo>

# draft the setup from the catalog
$ apos setup draft  # exit 0
Wrote .apos/project.yaml: app
Not committed. Edit it, commit it, then: apos setup probe --commit <sha>

# the probe runs every tool (the setup keeps only L2, where the captured tests go): the repo has no tests, and the tool says so
$ apos setup probe --commit d4dbb911db  # exit 0
none app.L2 pytest-acceptance: the tool reports no tests (exit 5, empty report)
ok   app.tests patterns: 10 patterns compile; tests under tests/**, **/test_*.py, **/*_test.py
setup c25214af7518 at d4dbb911db00: probe passed

# the Human approves without saying so: refused, there is no baseline
$ apos setup approve --commit d4dbb911db --on-behalf demo  # exit 1
The probe found no tests in app.L2: the repo has no baseline, so what the gates prove is weak. A Human can accept that with `apos setup approve --commit d4dbb911db00 --baseline-missing` (every Goal on this setup is then labelled low assurance), or add tests first

# the Human accepts a repo with no tests, knowingly: every Goal on this setup is labelled low assurance
$ apos setup approve --commit d4dbb911db --baseline-missing --on-behalf demo  # exit 0
Approved setup v1 (c25214af7518) at d4dbb911db00
BẢO ĐẢM THẤP: repo chưa có test nền (app.L2)
The label judges nothing differently: a layer with no tests is still red at the gate and at close. Keep in the setup only the layers that have tests to run (docs/setup.md).

# the PM drafts a characterize Goal: the behaviour of pricing.py as it is, odd corners included
$ apos goal create --file <apos>/examples/py-legacy/characterize.json --source <apos>/examples/py-legacy/brief.md --kind characterize --covers pricing.py  # exit 0
Drafted GOAL-001 (characterize)

# the Human approves it, and with it the code it covers (gate A)
$ apos goal approve GOAL-001 --size S --max-minutes 60 --max-attempts 3 --on-behalf demo  # exit 0
Approved GOAL-001 on setup v1

# the Human selects it
$ apos goal select GOAL-001 --on-behalf demo  # exit 0
Selected GOAL-001

# the Lead plans it: one Solo package, tests only
$ apos lead propose --characterize --goal GOAL-001  # exit 0
Proposed EXEC-001

# the Lead commits the plan: the Goal waits for the tests
$ apos lead commit GOAL-001  # exit 0
Accepted GOAL-001. Next the tester writes the acceptance tests and stubs: `apos tests submit GOAL-001 --commit <sha>`. Packages open once they are locked.

# a Tester writes what they think FREE0 should do: red on today's code, refused
$ apos tests submit GOAL-001 --commit 91a80631d4  # exit 1
tests refused on 91a80631d45a211e4bd802393a20ee4eab8a9ea2: nothing is locked
  AC-4 app.L2 tests.acceptance.test_pricing_today::test_ac4_the_code_free0_makes_the_order_free: chụp hành vi phải xanh trên code như hiện tại: the test is fail. Describe what the code does today, odd behaviour included; a wrong-looking result is a note for a later `apos bug`, not a failing test

# the Tester writes what the code does today: green twice, so it is locked
$ apos tests submit GOAL-001 --commit 1bafc2f77d  # exit 0
Locked 4 tests in 1 files on 1bafc2f77d0f9e7739ed236a516a00227db5036a. Packages are gated on top of this commit.

# no code to write: the Lead submits the commit that locked the tests
$ apos package submit GOAL-001 WP-MAIN --commit 1bafc2f77d  # exit 0
WP-MAIN green on 1bafc2f77d0f9e7739ed236a516a00227db5036a; GOAL-001 verified
  needs attention: declared risks: A test pins a defect as if it were wanted; the criterion says so, and a bug is opened later with apos bug

# the Human closes the Goal
$ apos outcome close GOAL-001 --on-behalf demo  # exit 0
Close-stage layers green on 1bafc2f77d0f9e7739ed236a516a00227db5036a
close GOAL-001

# the table opens with the warning, and says what was captured
$ apos goal show GOAL-001  # exit 0
GOAL-001	closed	Write down what pricing.py does today, so it can be restructured safely
setup v1
khoá test: commit 1bafc2f77d0f9e7739ed236a516a00227db5036a, 4 test, 1 file, 4 assert (đếm dòng, chỉ gần đúng)

BẢO ĐẢM THẤP: repo chưa có test nền (app.L2)
GOAL-001  setup v1  (app: python)
  Tiêu chí           4   máy chứng minh 4 · anh xác nhận tay 0
  Test đã khoá       L2 4
  Kiểm kê / phạm vi  bật
  Lớp khâu đóng      L2 pytest-acceptance ✓
  Chụp hành vi       4 test đã khoá, chụp hành vi hiện tại của pricing.py (hành vi lạ ghi thành ghi chú, mở `apos bug` sau)
  Agent duyệt thay   0 chỗ
  Tắt / chưa kiểm    L0 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L1 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L2 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L0 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L1 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L3 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L4 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L5 không chạy ở khâu close: setup không có công cụ cho lớp này

# the PM drafts a refactor Goal; its paths are every module
$ apos goal create --file <apos>/examples/py-legacy/refactor.json --source <apos>/examples/py-legacy/refactor-brief.md  # exit 0
Drafted GOAL-002 (refactor)

# the Human cannot approve it: shipping.py is not captured by any closed Goal
$ apos goal approve GOAL-002 --size M --max-minutes 120 --max-attempts 3 --on-behalf demo  # exit 1
GOAL-002 cannot be approved:
- not covered by a closed characterize Goal: shipping.py. Capture their behaviour first (a characterize Goal whose covers include them, closed), or take them out of paths

# the PM narrows the paths to pricing.py
$ apos goal revise --file <apos>/examples/py-legacy/refactor-v2.json --source <apos>/examples/py-legacy/refactor-brief.md  # exit 0
Revised GOAL-002 v2; Human approval required

# the Human approves it: every file it reaches is captured
$ apos goal approve GOAL-002 --size M --max-minutes 120 --max-attempts 3 --on-behalf demo  # exit 0
Approved GOAL-002 on setup v1

# the Human selects it
$ apos goal select GOAL-002 --on-behalf demo  # exit 0
Selected GOAL-002

# the Lead plans it on a base that holds the captured tests
$ apos lead propose --file <tmp>/work/refactor-plan.json  # exit 0
Proposed EXEC-002

# the Lead commits the plan
$ apos lead commit GOAL-002  # exit 0
Accepted GOAL-002. Deliver with `apos package submit GOAL-002 <package> --commit <sha>`.

# a refactor that "fixes" FREE0 changes behaviour: the captured test is red
$ apos package submit GOAL-002 WP-MAIN --commit eebac5f05b  # exit 1
WP-MAIN red on eebac5f05bc331923807f55ea383dd4f6ef91e2d
  APOS-CHARACTERIZED fail: GOAL-001: AC-4 app.L2 tests.acceptance.test_pricing_today::test_ac4_the_code_free0_makes_the_order_free: is fail, not pass
  app.L2.pytest-acceptance fail: app.L2 pytest-acceptance: 1 new failure(s) vs the base: tests.acceptance.test_pricing_today::test_ac4_the_code_free0_makes_the_order_free
  needs attention: declared risks: A rounding rule is lost in the split

# a refactor that only restructures: every captured test is green, the Goal is verified
$ apos package submit GOAL-002 WP-MAIN --commit bd3d209a6a  # exit 0
WP-MAIN green on bd3d209a6ae2eeff8984ec3336cef8599c348519; GOAL-002 verified
  needs attention: declared risks: A rounding rule is lost in the split

# the Human closes it: the captured tests run again at the close stage
$ apos outcome close GOAL-002 --on-behalf demo  # exit 0
Close-stage layers green on bd3d209a6ae2eeff8984ec3336cef8599c348519
close GOAL-002

# the table says how many tests were kept, from which Goal, green before and after
$ apos goal show GOAL-002  # exit 0
GOAL-002	closed	pricing.py is split into small steps and behaves exactly as before
setup v1
không có khoá test riêng: các test đã chụp của Goal characterize là bằng chứng (dòng "Giữ hành vi")

BẢO ĐẢM THẤP: repo chưa có test nền (app.L2)
GOAL-002  setup v1  (app: python)
  Tiêu chí           0   máy chứng minh 0 · anh xác nhận tay 0
  Test đã khoá       không có
  Kiểm kê / phạm vi  bật
  Lớp khâu submit    WP-MAIN: L2 pytest-acceptance ✓
  Lớp khâu đóng      L2 pytest-acceptance ✓
  Giữ hành vi        giữ nguyên hành vi: 4 test chụp từ GOAL-001, xanh trước trên 7069c84, xanh sau trên bd3d209
  Agent duyệt thay   0 chỗ
  Tắt / chưa kiểm    L0 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L1 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L0 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L1 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L3 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L4 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L5 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    khoá test: tắt (setup không khai tests.paths, hoặc Goal không có tiêu chí cần test)


demo py-legacy: every step ended as expected.
```

## A dependency upgrade (`ts-maint`: `fmt` 1.0.0 has CVE-FMT-1)

`npm run demo:maint` upgrades a dependency with no criterion written by anyone. `maintenance open --security CVE-FMT-1` scans the base once and finds the finding there; the gate then holds every delivery to the base. The first upgrade (`fmt` 2.0.0) breaks four tests that were green, the second touches `src/price.ts`, which is neither a manifest nor a declared path, and the third changes `package.json` only: it waits for a decision (a manifest is sensitive in the catalog), an agent approves it, and the same commit is green with the finding gone. The dependency is a folder in `vendor/`, so the demo needs no network.

```text
demo ts-maint: working in <tmp> (a temp directory; --keep leaves it)

# init the project
$ apos init  # exit 0
Initialized <repo>

# draft the setup from the catalog
$ apos setup draft  # exit 0
Wrote .apos/project.yaml: app
Not committed. Edit it, commit it, then: apos setup probe --commit <sha>

# probe every tool of the setup in a clean worktree
$ apos setup probe --commit 9f143d39e3  # exit 0
ok   app.L1 vitest: 2 tests, stable over 2 runs
ok   app.L2 vitest-acceptance: 1 tests, runOne ok, stable over 2 runs
ok   app.L3 vitest-integration: 1 tests, runOne ok
ok   app.L5 node-scan: findings
ok   app.tests patterns: 13 patterns compile; tests under **/*.test.ts, **/*.spec.ts, tests/**
setup 554c06fdbbb7 at 9f143d39e3e6: probe passed

# the Human approves the probed setup
$ apos setup approve --commit 9f143d39e3 --on-behalf demo  # exit 0
Approved setup v1 (554c06fdbbb7) at 9f143d39e3e6

# the PM opens a maintenance Goal that must remove CVE-FMT-1; the base is scanned once, and the finding is found there
$ apos maintenance open Upgrade fmt to a version without CVE-FMT-1 --security CVE-FMT-1 --paths CHANGELOG.md  # exit 0
Drafted GOAL-MAINT-001 (maintenance)
Next: the Human runs `apos maintenance approve GOAL-MAINT-001`

# it waits for the Human in the inbox
$ apos inbox  # exit 0
GOAL-MAINT-001	awaiting-approval	gates A and B in one go: apos maintenance approve GOAL-MAINT-001

# the Human approves, sets the default appetite and selects, in one command
$ apos maintenance approve GOAL-MAINT-001 --on-behalf demo  # exit 0
Approved and selected GOAL-MAINT-001 on setup v1 (S, 60 min, 3 attempts)
Next: the Lead plans it with `apos lead propose --maintenance --goal GOAL-MAINT-001`

# the Lead plans it: one Solo package, no Tester; its paths are the manifests plus the declared path
$ apos lead propose --maintenance --goal GOAL-MAINT-001  # exit 0
Proposed EXEC-MAINT-001

# the Lead commits the plan: the Goal is executing
$ apos lead commit GOAL-MAINT-001  # exit 0
Accepted GOAL-MAINT-001. Deliver with `apos package submit GOAL-MAINT-001 <package> --commit <sha>`.

# the Worker upgrades to fmt 2.0.0, which renames format(): a test green on the base is red now, so it is red
$ apos package submit GOAL-MAINT-001 WP-MAIN --commit e5e9e4ffa5  # exit 1
WP-MAIN red on e5e9e4ffa52e54c94829fd3146b7552728e05a03
  APOS-SCOPE needs-human: sensitive files changed, a decision is needed: package.json
  app.L1.vitest fail: app.L1 vitest: 2 new failure(s) vs the base: src/price.test.ts::shows a price in dollars and cents, src/price.test.ts::shows zero as $0.00
  app.L2.vitest-acceptance fail: app.L2 vitest-acceptance: 1 new failure(s) vs the base: src/price.acceptance.test.ts::a customer sees the same price text on every screen
  app.L3.vitest-integration fail: app.L3 vitest-integration: 1 new failure(s) vs the base: src/price.integration.test.ts::prices of a basket are all in the same format
  needs attention: declared risks: The upgrade changes behaviour the existing tests do not cover
  needs attention: files the checks run or are built from changed: package.json

# the Worker upgrades to 1.1.0 and also edits src/price.ts: not a manifest and not a declared path, so it is red
$ apos package submit GOAL-MAINT-001 WP-MAIN --commit 7233fffb92  # exit 1
WP-MAIN red on 7233fffb92a177b93b4f575f1a1b9d0208d79adc
  APOS-SCOPE fail: outside the package paths (package.json, package-lock.json, pnpm-lock.yaml, yarn.lock, CHANGELOG.md): src/price.ts; sensitive files also changed: package.json
  needs attention: declared risks: The upgrade changes behaviour the existing tests do not cover
  needs attention: files the checks run or are built from changed: package.json

# the Worker upgrades to 1.1.0 and nothing else: package.json is a sensitive file, so the gate waits for a decision
$ apos package submit GOAL-MAINT-001 WP-MAIN --commit 1fc5fa2fdb  # exit 3
WP-MAIN needs-human on 1fc5fa2fdb70fb1e07fb29f710ed43d471533277
  APOS-SCOPE needs-human: sensitive files changed, a decision is needed: package.json
  needs attention: declared risks: The upgrade changes behaviour the existing tests do not cover
  needs attention: files the checks run or are built from changed: package.json

# an agent approves the manifest change on the Human’s behalf (the table will say so)
$ apos exception approve GOAL-MAINT-001 --kind needs-human --ref WP-MAIN --reason a dependency upgrade changes package.json by definition --by agent:lead  # exit 0
Approved needs-human for WP-MAIN on 1fc5fa2fdb70fb1e07fb29f710ed43d471533277 by agent:lead. Submit WP-MAIN again with the same commit.

# the same commit again: no new failure, no new finding, CVE-FMT-1 gone, only the manifest changed: green
$ apos package submit GOAL-MAINT-001 WP-MAIN --commit 1fc5fa2fdb  # exit 0
WP-MAIN green on 1fc5fa2fdb70fb1e07fb29f710ed43d471533277; GOAL-MAINT-001 verified
  needs attention: declared risks: The upgrade changes behaviour the existing tests do not cover
  needs attention: files the checks run or are built from changed: package.json

# the Human closes the Goal on the commit that passed the gate
$ apos outcome close GOAL-MAINT-001 --on-behalf demo  # exit 0
Close-stage layers green on 1fc5fa2fdb70fb1e07fb29f710ed43d471533277
close GOAL-MAINT-001

# the assurance table says what was proved against the base
$ apos goal show GOAL-MAINT-001  # exit 0
GOAL-MAINT-001	closed	Upgrade fmt to a version without CVE-FMT-1
setup v1
không có khoá test (setup không khai tests.paths, hoặc Goal không có tiêu chí cần test)

GOAL-MAINT-001  setup v1  (app: typescript)
  Tiêu chí           0   máy chứng minh 0 · anh xác nhận tay 0
  Test đã khoá       không có
  Kiểm kê / phạm vi  bật
  Lớp khâu submit    WP-MAIN: L1 vitest ✓ · L2 vitest-acceptance ✓ · L3 vitest-integration (Goal bảo trì) ✓ · L5 node-scan (Goal bảo trì) ✓
  Lớp khâu đóng      L1 vitest ✓ · L2 vitest-acceptance ✓ · L3 vitest-integration ✓ · L5 node-scan ✓
  Bảo trì            chỉ chạm manifest/lockfile (+ paths); lỗi có sẵn trên base: 0; lỗi mới: 0
  Quét               finding mới 0 (dưới mức chặn: 0)
  Vá bảo mật         finding CVE-FMT-1 (h:1dec7211f4b07fa0) có trên c0d0f4a, không còn trên 1fc5fa2
  Duyệt              duyệt gộp bằng maintenance approve (on-behalf:demo)
  Ngoại lệ           needs-human WP-MAIN (agent:lead): a dependency upgrade changes package.json by definition
  Agent duyệt thay   1 chỗ: needs-human WP-MAIN (agent:lead)
  Tắt / chưa kiểm    L0 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L0 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L4 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    khoá test: tắt (setup không khai tests.paths, hoặc Goal không có tiêu chí cần test)

demo ts-maint: every step ended as expected.
```

## Removing a feature (`py-remove`: the shop drops its coupons)

`npm run demo:remove` takes a feature out and shows what the gate lets disappear. The Goal has one criterion, `proof: "removed"`, whose `removesTests` names the two old tests that describe coupons. `goal approve` prints the tests that will go before the Human confirms. The Tester locks two tests of absence (`total()` takes no coupon, the cart module has no `apply_coupon`), red while coupons exist. Then three deliveries: one deletes a test nobody declared (red, and it is named), one removes the code and leaves a declared test (red, `declared removed but still there`), and the one that removes the feature and exactly the two declared tests is green. The table ends with the `Xoá tính năng` line.

```text
demo py-remove: working in <tmp> (a temp directory; --keep leaves it)

# init the project
$ apos init  # exit 0
Initialized <repo>

# draft the setup from the catalog
$ apos setup draft  # exit 0
Wrote .apos/project.yaml: app
Not committed. Edit it, commit it, then: apos setup probe --commit <sha>

# probe every tool of the setup in a clean worktree
$ apos setup probe --commit 279a204583  # exit 0
ok   app.L1 pytest: 4 tests, stable over 2 runs
ok   app.L2 pytest-acceptance: 1 tests, runOne ok, stable over 2 runs
ok   app.L3 pytest-integration: 1 tests, runOne ok
ok   app.tests patterns: 10 patterns compile; tests under tests/**, **/test_*.py, **/*_test.py
setup f715beccff6c at 279a20458320: probe passed

# the Human approves the probed setup
$ apos setup approve --commit 279a204583 --on-behalf demo  # exit 0
Approved setup v1 (f715beccff6c) at 279a20458320

# the PM drafts the Goal: one criterion, "coupons are gone", that names the two old tests that go with them
$ apos goal create --file <apos>/examples/py-remove/goal.json --source <apos>/examples/py-remove/brief.md  # exit 0
Drafted GOAL-001

# the Human approves: before confirming they are shown the tests the Goal will remove, found on the repo as it is
$ apos goal approve GOAL-001 --size S --max-minutes 60 --max-attempts 5 --on-behalf demo  # exit 0
GOAL-001 will remove these tests, and only these (the rest must stay):
  AC-1: 2 test(s)
    - app.L1::tests.test_coupons::test_ten_percent_coupon_takes_off_a_tenth
    - app.L1::tests.test_coupons::test_an_unknown_coupon_is_refused
Approved GOAL-001 on setup v1

# the Human selects it
$ apos goal select GOAL-001 --on-behalf demo  # exit 0
Selected GOAL-001

# the Lead proposes a Solo plan
$ apos lead propose --file <tmp>/work/plan.json  # exit 0
Proposed EXEC-001

# the Lead commits the plan: the Goal waits for the test that says coupons are gone
$ apos lead commit GOAL-001  # exit 0
Accepted GOAL-001. Next the tester writes the acceptance tests and stubs: `apos tests submit GOAL-001 --commit <sha>`. Packages open once they are locked.

# the Tester hands over two tests of absence (total() takes no coupon, the cart has no apply_coupon): red while coupons exist, so they are locked
$ apos tests submit GOAL-001 --commit a7210367e3  # exit 0
Locked 2 tests in 1 files on a7210367e3a292f5d0d0db8622885622131618c8. Packages are gated on top of this commit.

# a Worker removes coupons and also deletes a test nobody declared: red, and it names the test
$ apos package submit GOAL-001 WP-MAIN --commit 893d50459b  # exit 1
WP-MAIN red on 893d50459b38bec69f0cfa0914839c75bd1ad356
  APOS-INVENTORY fail: test missing: app.L1::tests.test_cart::test_an_empty_cart_totals_zero
  needs attention: declared risks: A test that only looks unrelated is deleted with the feature: the inventory names it

# a Worker removes coupons but keeps one of the two declared tests: red, "declared removed but still there"
$ apos package submit GOAL-001 WP-MAIN --commit 29ac44c53e  # exit 1
WP-MAIN red on 29ac44c53eff1894f7150b3f53457d27a2914c16
  CHK-1 fail: exit 1 on delivery
  APOS-INVENTORY fail: declared removed but still there: app.L1::tests.test_coupons::test_an_unknown_coupon_is_refused
  app.L1.pytest fail: app.L1 pytest: 1 new failure(s) vs the base: tests.test_coupons::test_an_unknown_coupon_is_refused
  needs attention: declared risks: A test that only looks unrelated is deleted with the feature: the inventory names it

# a Worker removes coupons and exactly the two declared tests: the test of absence is green, no other test is lost
$ apos package submit GOAL-001 WP-MAIN --commit 58430618dc  # exit 0
WP-MAIN green on 58430618dc83d0b96e7847d7115ca0875f78641b; GOAL-001 verified
  needs attention: declared risks: A test that only looks unrelated is deleted with the feature: the inventory names it

# the Human closes the Goal on the commit that passed the gate
$ apos outcome close GOAL-001 --on-behalf demo  # exit 0
Close-stage layers green on 58430618dc83d0b96e7847d7115ca0875f78641b
close GOAL-001

# the assurance table says which test proved the feature gone and how many old tests went
$ apos goal show GOAL-001  # exit 0
GOAL-001	closed	The shop no longer takes coupons, and nothing else changes
setup v1
khoá test: commit a7210367e3a292f5d0d0db8622885622131618c8, 2 test, 1 file, 2 assert (đếm dòng, chỉ gần đúng)

GOAL-001  setup v1  (app: python)
  Tiêu chí           1   máy chứng minh 1 · anh xác nhận tay 0
  Test đã khoá       L2 2
  Kiểm kê / phạm vi  bật
  Lớp khâu submit    WP-MAIN: L1 pytest ✓ · L2 pytest-acceptance ✓
  Lớp khâu đóng      L1 pytest ✓ · L2 pytest-acceptance ✓ · L3 pytest-integration ✓
  Xoá tính năng      AC-1: test app.L2::tests.acceptance.test_no_coupons::test_total_no_longer_takes_a_coupon, app.L2::tests.acceptance.test_no_coupons::test_the_cart_no_longer_knows_how_to_apply_one đỏ trên a721036, xanh trên 5843061; xoá đúng 2 test đã khai
  Agent duyệt thay   0 chỗ
  Tắt / chưa kiểm    L0 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L0 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L4 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L5 không chạy ở khâu close: setup không có công cụ cho lớp này

demo py-remove: every step ended as expected.
```
