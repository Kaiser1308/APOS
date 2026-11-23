# Demo: three example Goals, run for real

`npm run demo:ts`, `npm run demo:py` and `npm run demo:bug` copy an example from `examples/` to a temp directory, `git init` it and drive the **real** APOS binary (`dist/cli.js`, so run `npm run build` first) with a real test runner (vitest, pytest). Every step prints the command, its exit code and what APOS said, and checks the exit code it expected; a surprise exits 1. A machine without a tool the example needs (`git`, `npx`/vitest, `python`/pytest) stops at once with exit 2 and names it: the script never reports a pass it did not see. `--keep` leaves the temp directory in place. See `examples/README.md` for the files of an example.

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
