# Demo: two example Goals, run for real

`npm run demo:ts` and `npm run demo:py` copy an example from `examples/` to a temp directory, `git init` it and drive the **real** APOS binary (`dist/cli.js`, so run `npm run build` first) with a real test runner (vitest, pytest). Every step prints the command, its exit code and what APOS said, and checks the exit code it expected; a surprise exits 1. A machine without a tool the example needs (`git`, `npx`/vitest, `python`/pytest) stops at once with exit 2 and names it: the script never reports a pass it did not see. `--keep` leaves the temp directory in place. See `examples/README.md` for the files of an example.

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
$ apos setup probe --commit 97dcc7d68f  # exit 0
ok   app.L1 vitest: 3 tests, stable over 2 runs
ok   app.L2 vitest-acceptance: 1 tests, runOne ok, stable over 2 runs
ok   app.L3 vitest-integration: 1 tests, runOne ok
ok   app.L5 bench: metric
ok   app.tests patterns: 11 patterns compile; tests under **/*.test.ts, **/*.spec.ts, tests/**
setup 3d776992da34 at 97dcc7d68f7a: probe passed

# the Human approves the probed setup
$ apos setup approve --commit 97dcc7d68f --on-behalf demo  # exit 0
Approved setup v1 (3d776992da34) at 97dcc7d68f7a

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
$ apos lead propose --file /tmp/apos-demo-ts-orders-ly5iu3/work/plan.json  # exit 0
Proposed EXEC-001

# the Lead commits the plan: the Goal waits for locked tests
$ apos lead commit GOAL-001  # exit 0
Accepted GOAL-001. Next the tester writes the acceptance tests and stubs: `apos tests submit GOAL-001 --commit <sha>`. Packages open once they are locked.

# the Tester hands over acceptance tests and a stub: red for the right reason, so they are locked
$ apos tests submit GOAL-001 --commit 92966af8cb  # exit 0
Locked 3 tests in 1 files on 92966af8cbbb759cfc7fcdf99b5c3f83a0afcafe. Packages are gated on top of this commit.

# a Worker makes the test pass by weakening it: red
$ apos package submit GOAL-001 WP-MAIN --commit ad7de1055e  # exit 1
WP-MAIN red on ad7de1055efaeb8e7125c2252b357558cefa5c3b
  APOS-LOCKED fail: locked test modified: src/cancel.acceptance.test.ts; AC-2 app.L2 src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled: not in the delivery report
  APOS-INVENTORY fail: test missing: app.L2::src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled
  app.L2.vitest-acceptance fail: app.L2 vitest-acceptance: locked test src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled is not in the report, not pass
  needs attention: declared risks: The old shipped-order rule lives in the same function and has no test

# a Worker delivers code with a bug: the locked test is red
$ apos package submit GOAL-001 WP-MAIN --commit 4fbe5726a2  # exit 1
WP-MAIN red on 4fbe5726a2608cc41af97b09cfc1a572cb7b846b
  CHK-1 fail: exit 1 on delivery
  APOS-LOCKED fail: AC-2 app.L2 src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled: is fail, not pass
  app.L2.vitest-acceptance fail: app.L2 vitest-acceptance: locked test src/cancel.acceptance.test.ts::AC-2: an order placed exactly 30 days ago can still be cancelled is fail, not pass
  needs attention: declared risks: The old shipped-order rule lives in the same function and has no test

# a Worker delivers code that meets every acceptance test: green, the Goal is verified
$ apos package submit GOAL-001 WP-MAIN --commit 9a72ee62ef  # exit 0
WP-MAIN green on 9a72ee62ef3917c2af6b317abf31c087454bd486; GOAL-001 verified
  needs attention: declared risks: The old shipped-order rule lives in the same function and has no test

# a Reviewer finds what the tests missed and says it with a test: it is red, so the package is blocked
$ apos review block GOAL-001 WP-MAIN --commit d2204c3715 --by reviewer  # exit 1
WP-MAIN blocked by review on d2204c371555221bdc1936bb3b9a3755377bcd5f: blocked by review: src/cancel.review.test.ts::a shipped order is never reported as cancelled
  1 test(s) are now locked into the next delivery. Build the fix on d2204c371555221bdc1936bb3b9a3755377bcd5f.

# the final fix, built on the review commit: its test is locked and passes
$ apos package submit GOAL-001 WP-MAIN --commit 912af674cf  # exit 0
WP-MAIN green on 912af674cfe0bb8047dd411c41784720863316f1; GOAL-001 verified
  needs attention: declared risks: The old shipped-order rule lives in the same function and has no test

# the Human closes the Goal: the close-stage layers (the benchmark among them) run on the verified commit
$ apos outcome close GOAL-001 --on-behalf demo  # exit 0
Close-stage layers green on 912af674cfe0bb8047dd411c41784720863316f1
close GOAL-001

# the assurance table: what the machine proved, and what it did not
$ apos goal show GOAL-001  # exit 0
GOAL-001	closed	An order placed more than 30 days ago cannot be cancelled
setup v1
khoá test: commit 92966af8cbbb759cfc7fcdf99b5c3f83a0afcafe, 3 test, 1 file, 4 assert (đếm dòng, chỉ gần đúng)

GOAL-001  setup v1  (app: typescript)
  Tiêu chí           3   máy chứng minh 3 · anh xác nhận tay 0
  Test đã khoá       L2 3
  Kiểm kê / phạm vi  bật
  Lớp khâu submit    WP-MAIN: L1 vitest ✓ · L2 vitest-acceptance ✓
  Lớp khâu đóng      L1 vitest ✓ · L2 vitest-acceptance ✓ · L3 vitest-integration ✓ · L5 bench ✓ (files.0.groups.0.benchmarks.0.p99 0.3896480000000224)
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
$ apos setup probe --commit 4362e1ae67  # exit 0
ok   app.L1 pytest: 3 tests, stable over 2 runs
ok   app.L2 pytest-acceptance: 1 tests, runOne ok, stable over 2 runs
ok   app.L3 pytest-integration: 1 tests, runOne ok
ok   app.L5 bench: metric
ok   app.tests patterns: 10 patterns compile; tests under tests/**, **/test_*.py, **/*_test.py
setup e75d73087f33 at 4362e1ae67ca: probe passed

# the Human approves the probed setup
$ apos setup approve --commit 4362e1ae67 --on-behalf demo  # exit 0
Approved setup v1 (e75d73087f33) at 4362e1ae67ca

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
$ apos lead propose --file /tmp/apos-demo-py-parking-GGfl5H/work/plan.json  # exit 0
Proposed EXEC-001

# the Lead commits the plan: the Goal waits for locked tests
$ apos lead commit GOAL-001  # exit 0
Accepted GOAL-001. Next the tester writes the acceptance tests and stubs: `apos tests submit GOAL-001 --commit <sha>`. Packages open once they are locked.

# the Tester hands over acceptance tests and a stub: red for the right reason, so they are locked
$ apos tests submit GOAL-001 --commit e81dc51a75  # exit 0
Locked 3 tests in 1 files on e81dc51a75db83699fcd327d11ddd41824af7623. Packages are gated on top of this commit.

# a Worker makes the test pass by weakening it: red
$ apos package submit GOAL-001 WP-MAIN --commit 8f4cd04a5b  # exit 1
WP-MAIN red on 8f4cd04a5be4e5b43af32255fb2f9e22aa68fb5b
  APOS-LOCKED fail: locked test modified: tests/acceptance/test_sensor.py
  needs attention: declared risks: The old rule about reserved slots lives in the same function and has no test

# a Worker delivers code with a bug: the locked test is red
$ apos package submit GOAL-001 WP-MAIN --commit d1e507c4d8  # exit 1
WP-MAIN red on d1e507c4d8a20c03b7522bcc5a450c3d696f5589
  CHK-1 fail: exit 1 on delivery
  APOS-LOCKED fail: AC-2 app.L2 tests.acceptance.test_sensor::test_ac2_a_reserved_slot_becomes_occupied_when_the_booked_car_arrives: is fail, not pass
  app.L2.pytest-acceptance fail: app.L2 pytest-acceptance: locked test tests.acceptance.test_sensor::test_ac2_a_reserved_slot_becomes_occupied_when_the_booked_car_arrives is fail, not pass
  needs attention: declared risks: The old rule about reserved slots lives in the same function and has no test

# a Worker delivers code that meets every acceptance test: green, the Goal is verified
$ apos package submit GOAL-001 WP-MAIN --commit 9336c5ad51  # exit 0
WP-MAIN green on 9336c5ad51b9ab8a62e3f183c2ddcee64e993aab; GOAL-001 verified
  needs attention: declared risks: The old rule about reserved slots lives in the same function and has no test

# a Reviewer finds what the tests missed and says it with a test: it is red, so the package is blocked
$ apos review block GOAL-001 WP-MAIN --commit 6f49939b81 --by reviewer  # exit 1
WP-MAIN blocked by review on 6f49939b81c6c81add761a4a21a666bbc5c36163: blocked by review: tests.test_sensor_review::test_a_reservation_is_never_freed_by_an_empty_reading
  1 test(s) are now locked into the next delivery. Build the fix on 6f49939b81c6c81add761a4a21a666bbc5c36163.

# the final fix, built on the review commit: its test is locked and passes
$ apos package submit GOAL-001 WP-MAIN --commit 75c61ddef8  # exit 0
WP-MAIN green on 75c61ddef89d6127da86740f73f089a50fe82914; GOAL-001 verified
  needs attention: declared risks: The old rule about reserved slots lives in the same function and has no test

# the Human closes the Goal: the close-stage layers (the benchmark among them) run on the verified commit
$ apos outcome close GOAL-001 --on-behalf demo  # exit 0
Close-stage layers green on 75c61ddef89d6127da86740f73f089a50fe82914
close GOAL-001

# the assurance table: what the machine proved, and what it did not
$ apos goal show GOAL-001  # exit 0
GOAL-001	closed	A slot becomes occupied when its sensor reports a car
setup v1
khoá test: commit e81dc51a75db83699fcd327d11ddd41824af7623, 3 test, 1 file, 3 assert (đếm dòng, chỉ gần đúng)

GOAL-001  setup v1  (app: python)
  Tiêu chí           3   máy chứng minh 3 · anh xác nhận tay 0
  Test đã khoá       L2 3
  Kiểm kê / phạm vi  bật
  Lớp khâu submit    WP-MAIN: L1 pytest ✓ · L2 pytest-acceptance ✓
  Lớp khâu đóng      L1 pytest ✓ · L2 pytest-acceptance ✓ · L3 pytest-integration ✓ · L5 bench ✓ (p95_ms 0.194)
  Review chặn        1 lần bằng test đỏ, 1 test đã khoá vào lần giao sau
  Agent duyệt thay   0 chỗ
  Tắt / chưa kiểm    L0 không chạy ở khâu submit: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L0 không chạy ở khâu close: setup không có công cụ cho lớp này
  Tắt / chưa kiểm    L4 không chạy ở khâu close: setup không có công cụ cho lớp này

demo py-parking: every step ended as expected.
```

