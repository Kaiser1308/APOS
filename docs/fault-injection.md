# APOS v3 safety cases

Threshold: **0 false verification, 0 unauthorized merge, 0 close of a commit that did not pass the gate.** A Human decision needs a person at a terminal or an explicit `--on-behalf`; this guards against an agent or script acting by mistake, not against a local process that deliberately passes the flag (see the trust model in the README). Every case below is an automated test; run them with `npm test`.

This file was rewritten in phase 1 of v3, when APOS stopped starting, waking and watching agents. [Cases that were dropped](#cases-dropped-in-phase-1-and-why) are listed at the end.

## Output is proven by a gate, not by anyone's word

| Injected fault | Expected | Test |
| --- | --- | --- |
| Owner claims `pass`, no gate ran | not verified | `verification.test.ts` › rejects a self-declared pass when the controller has not run the gate |
| Owner claims `pass`, gate red | not verified | › rejects a red gate even when the owner reported pass |
| Gate `unverifiable` (flaky, hung, baseline cannot run) | never green | `verification.test.ts` › rejects an unverifiable gate; `gate.test.ts` (domain) › is unverifiable when repeated runs disagree or a run times out |
| Wrong log / artifact | the gate writes its own logs and hashes them outside the repo; owner artifacts are never read as proof | `gate-service.test.ts` › goes green … with logs hashed outside the repo |
| An AI tool wired into the setup that gives a different answer each run | the probe fails (`flaky`), the setup cannot be approved; a stable one passes | `setup-probe.test.ts` › fails an AI tool that writes different tests every time it runs, and passes one that is stable |
| Mutation score under the floor, or under a Goal criterion that raises it | the close stage is red, the message gives both thresholds and the scores | `mutation-flow.test.ts` |
| Mutation runs that give scores more than 1 point apart, or a run that fails or leaves no report | `unverifiable`, never green | `mutation-flow.test.ts`; `layer-gate.test.ts` |
| `goal approve --flag mutation` on a setup without a mutation tool | refused, nothing written | `goal-approve-proof.test.ts` |
| Stale commit: gate on X, verify or merge of Y | refused | `verification.test.ts` › rejects a green gate that ran on a different commit; `merge.test.ts` › merges only the gated commit |
| A gate that finishes after its package moved on | rejected | `verification.test.ts` › rejects a gate that finishes after its package moved on |
| Plan revised after a gate | the gate is dropped | `verification.test.ts` › drops the gate when the Lead revises its plan |
| Uncommitted files in the owner tree | not counted | `gate-service.test.ts` › runs in a clean checkout |
| Delivery not descended from base | refused | `gate-service.test.ts` › refuses a delivery commit that does not descend from the base |
| New failing test | red, names the test | `gate-service.test.ts` › goes red and names the test the delivery newly broke |
| Base red, or baseline cannot run | `unverifiable`, never green | `gate-service.test.ts` › is unverifiable when the baseline suite cannot run |
| Hung check | process tree killed, workspace removed | `gate-service.test.ts` › kills a hung check at its timeout |
| A new failure that does not reproduce (seen live: two gates on one commit) | one fresh delivery rerun; only failures seen twice count | `gate-service.test.ts` › does not go red on a new failure that does not reproduce |
| Two gates on one project at once | one at a time; a dead holder's lease is cleared | `lease.test.ts` |
| Source changed after approval | approval and gate refused; editing the repo copy changes nothing | `cli.test.ts` › refuses approval when the source snapshot was edited; `gate-service.test.ts` › refuses to gate when the controller source snapshot changed |
| Requirement left unmapped, or an open question | Goal not approvable; plan not accepted | `contracts.test.ts` › Goal approval readiness; `cli.test.ts` |
| Plan against another source, or estimate over the budget | not accepted (`needs-decision`) | `v2-rules.test.ts` › accepts a plan that fits …; › refuses a plan made against another source snapshot; › sends an estimate over the appetite to a Human decision |
| Delivery rewrites an APOS skill, Goal document or source | gate red (`APOS-PROTECTED`) | `gate-service.test.ts` › fails the gate when the delivery rewrites an APOS-managed file |
| Intent gap found during execution | Goal parked for PM and Human | `v2-rules.test.ts` › parks the Goal for PM and Human on an intent gap |
| Manual check confirmed by whoever submitted the work | refused | `gate-service.test.ts` › accepts manual confirmation only for a declared manual check … |
| Tests, oracles, check-run files or build manifests changed | **warning in the gate report, the inbox and the UI; not blocked** for a Goal with no locked tests (a locked test changing is red: see [phase 3](#locked-tests-inventory-and-scope-phase-3)) | `v2-rules.test.ts` › warns when the gated diff changes tests …; `inbox.test.ts` › shows the warnings a gate report carries |
| A review (a person, a model or a tool) says `changes` in words | recorded as advice; gates nothing | `review-flow.test.ts` › advice is not a block; `integration.test.ts` › no longer needs a review to integrate |
| A review commit with a red test | the package is red (`blocked by review: <ids>`), the Goal executing again; the tests are locked into the next delivery | `review-flow.test.ts` › a red test blocks, is locked into the next delivery, and a fix on top of it passes; `review-tests.test.ts` › review-blocked |
| A review test that cannot load; a review that edits a test, adds a non-test file, or has another parent | refused, nothing recorded | `review-flow.test.ts` › a review may only add tests that load … |
| The delivery that was blocked sent again without the review commit; the review's test edited | refused; red `APOS-REVIEW` | `review-flow.test.ts`; `review-tests.test.ts` › the review check of a delivery |
| A Lead overrides a block | the delivery goes through; the table says `review bị bỏ qua: <ids>, duyệt bởi <by>` | `review-flow.test.ts`; `review-tests.test.ts` › the assurance table |

## Submitting a package

| Injected fault | Expected | Test |
| --- | --- | --- |
| Red, then green | a red counts an attempt, a green Solo package verifies the Goal in the same command | `submit.test.ts` › goes red, then green …; `transitions.test.ts` › goes pending, submitted, then green … |
| Commit that does not exist, or does not contain the base | refused, nothing written | `submit.test.ts` › refuses a commit that does not exist …; `v3-flow.test.ts` › refuses a Human command with no terminal … |
| Unknown package, green package, Goal not executing, short sha | refused with the reason | `submit.test.ts` › refuses a package that is unknown, already green …; `transitions.test.ts` › refuses to submit a green package or a short commit |
| More reds than the approved attempts | Goal `blocked`; only the Human goes on | `submit.test.ts` › blocks the Goal once reds pass the approved attempts; `transitions.test.ts` |
| Gate interrupted (Ctrl-C, timeout, executor error) | no gate record, no stuck `submitted`, submit again works | `submit.test.ts` › leaves no gate record when the gate is interrupted … |
| Crash between the two writes of a submission | the package is `submitted`; submitting again finishes it | `submit.test.ts` › can finish a submission whose gate record was lost … |
| Gate for another commit or attempt, or none submitted | rejected | `transitions.test.ts` › rejects a gate for another commit or attempt … |
| Unverifiable gate | package `needs-human`, no attempt spent | `transitions.test.ts` › sends an unverifiable gate to a Human … |
| Past the approved minutes | `ask`: Goal blocked; `stop`: refused, nothing written; nothing is gated | `submit.test.ts` › with overrun ask / stop …; `transitions.test.ts` › refuses a submission after the approved minutes |
| Solo Goal verified without a green package | refused | `transitions.test.ts` › refuses to verify a Solo Goal whose package is not green |
| Two packages, integration gate | verified only on a green integration gate that contains every package commit | `integration.test.ts`; `v3-flow.test.ts` › runs two packages, an integration gate … |

## Human decisions, closing and merging

| Injected fault | Expected | Test |
| --- | --- | --- |
| A Human command with no terminal and no `--on-behalf`, or a mistyped id | refused, nothing written to the log | `human-confirm.test.ts`; `cli.test.ts` › refuses a Human command without a terminal or --on-behalf …; `v3-flow.test.ts` |
| `--max-spend` | refused with the reason, nothing written | `cli.test.ts` › approves a Goal without --max-spend and says the flag is gone … |
| Close a Goal that is not verified, or whose verified commit is not the last green gate's | refused, `--on-behalf` included | `transitions.test.ts` › closes only on the commit that went green; › refuses to close a Goal whose verified commit …; › refuses to close when the last gate is not green; › refuses a Multi-WP close unless …; `v3-flow.test.ts` |
| Merge without authorization | refused | `verification.test.ts` › does not infer merge permission …; `merge.test.ts` |
| Target branch moved after verification | gated commit merged, gate rerun on the merge; red keeps the Goal open | `v3-flow.test.ts` › keeps the Goal open when the target branch moved … |

## Logs and old logs

| Injected fault | Expected | Test |
| --- | --- | --- |
| Event log edited or forged | reported, not trusted; a torn tail from a crash is dropped | `project-history.test.ts` › reports an edited or forged event; › drops a torn final line |
| Goal events committed into the repo by an owner | ignored | `journal.test.ts` › ignores Goal events an owner commits into the repo |
| Lost SQLite index | rebuilt from the controller log | `journal.test.ts` › rebuilds a lost SQLite index |
| A log written by APOS v2 (orchestration events) | replays without throwing, hash chain verified, Goal is `legacy` | `replay-compat.test.ts` (four real v2 logs, pinned state and pinned legacy Goals); `transitions.test.ts` › legacy Goals |
| Writing to a legacy Goal, or appending an orchestration or unknown event type | refused with the reason; the log is untouched | `journal.test.ts` › refuses to append an orchestration event, or anything at all to a legacy Goal … |
| `maxSpendUsd` in an old budget | still parses | `contracts.test.ts` › still reads the budget an older APOS recorded |
| Event type unknown to this build (rollback after a newer APOS wrote it) | ignored on replay; the Goal survives | `transitions.ts` reducer default branch |

## Setup, catalog and result formats (phase 2)

| Injected fault | Expected | Test |
| --- | --- | --- |
| Truncated, mismatched, empty or non-XML JUnit report | `unreadable` with a reason, never an exception, never "0 tests, green" | `results.test.ts` › junit › is unreadable …; `failures.test.ts` |
| Check whose report file is missing or broken | check `unverifiable`, gate not green | `gate-service.test.ts` › checks that read a standard report |
| Same test twice in one report | stable `#2` suffix, same ids every run | `results.test.ts` › junit › Surefire |
| Setup edited after its probe | `approve` refused: no passing probe for that sha256 | `setup-probe.test.ts` › needs a passing probe of exactly this text; `setup-flow.test.ts` |
| Approval without a passing probe, or a version that skips | refused when appended to the project log | `project-log.test.ts` |
| Project log edited | reported as tampering; torn tail dropped | `project-log.test.ts` › detects an edited line |
| `runOne` runs two tests, none, or another one | probe fails and names the test | `setup-probe.test.ts` › fails and names the test when runOne … |
| Test module that cannot be imported (pytest collection failure: every testcase is an `<error>`) | probe fails: `tests could not load: <message>`, not "1 tests, stable" | `setup-probe.test.ts` › tests that never loaded; `setup-e2e.test.ts` (real pytest) |
| `runOne` of a test whose name is a prefix of another (`test_add`, `test_add_neg`), a class test, or a vitest test nested in `describe` | runs exactly that one test; the draft passes the probe | `setup-e2e.test.ts` (real pytest and vitest, skipped when absent) |
| Same setup text probed at commit A (fail) then B (fail for another reason), approve at B | the reason of the latest probe at B; a commit never probed says so | `setup-probe.test.ts` › judges by the latest probe at this commit |
| Tool that does not exist, times out, or gives different results on two runs | probe fails with the reason | `setup-probe.test.ts` |
| Part whose stack is not recognised | draft still produced, part empty, note `chưa nhận ra stack` | `setup-draft.test.ts` |
| Delivery edits `.apos/project.yaml` | gate red, `APOS-PROTECTED` | `gate-service.test.ts` › fails the gate when the delivery edits the approved setup |
| Goal pinned to a setup version that was never approved | refused | `goal-setup-pin.test.ts`; `journal.test.ts` |
| Setup approved after a Goal was approved | the Goal keeps its pinned version | `goal-setup-pin.test.ts` |
| Approving without a terminal and without `--on-behalf` | refused | `setup-flow.test.ts` |

## Locked tests, inventory and scope (phase 3)

`APOS-INVENTORY` and `APOS-SCOPE` apply to every Goal pinned to a setup (the inventory against the plan base when there is no lock; the scope when the plan names `paths`); `APOS-LOCKED` only to a Goal with locked tests. A Goal pinned to no setup gets none of them. Every case is a test with a real git repo and a fake test tool (`test-lock.test-support.ts`); the end-to-end cases also run real pytest and vitest (`locked-flow.test.ts`, skipped when the runner is absent).

| Injected fault | Expected | Test |
| --- | --- | --- |
| Test already green when submitted (a stub that works, or a test that never calls it) (review focus 1) | `tests submit` refuses and names the test; nothing locked | `test-lock.test.ts` › refuses a test that is already green and names it; `locked-flow.test.ts` |
| Test red because it never loaded: load error, or an error that is not "not implemented" (review focus 2) | refused, not counted as red | `test-lock.test.ts` › refuses a test that is red because it did not load, or because of a typo; `test-lock.test.ts` (domain) › judgeSuite |
| A mapped test the report does not hold | refused: the file did not load | `test-lock.test.ts` › refuses a test the report does not hold |
| Tester commit touches source, docs or an undeclared file; deletes a test file | refused naming the file | `test-lock.test.ts` › lets the tester touch tests, declared stubs and tests.json …; › refuses to delete an existing test file |
| `tests.json` missing, invalid, or a criterion without a test | refused, every problem listed at once | `test-lock.test.ts` › needs tests.json …; › reports every problem at once |
| Two runs of the same commit disagree | refused: flaky | `test-lock.test.ts` › refuses when two runs … disagree |
| Package branched from the old base, without the locked commit (review focus 3) | `package submit` refused: rebase onto the lock commit | `assurance-gate.test.ts` › refuses a package branched from the old base …; `test-lock.test.ts` › … does not contain the plan base |
| Locked test edited by one space, or deleted (review focus 5) | gate red `locked test modified: <path>` | `assurance-gate.test.ts` › is red when the worker changes a locked test …; `assurance.test.ts`; `locked-flow.test.ts` |
| Locked test edited and the runner broken in the same commit | still red (`locked test modified`), not `unverifiable` | `assurance-gate.test.ts` › a locked test edited while the runner is also broken is red …; `assurance.test.ts` |
| Wide `paths` (`tests/**`, `**`): a package adds `tests/conftest.py` with a `pytest_runtest_makereport` hook that turns failures into passes, or `vitest.config.ts` + `setupFiles` that mocks the code under test, so the locked red test reads green | the gate is not green: `APOS-INFRA needs-human: hạ tầng test bị sửa: <path>` (the report shows `APOS-LOCKED` passing: that is the false green being judged) | `locked-flow.test.ts` › … swallowing the failure of the locked test is not green (real pytest and vitest); `assurance-gate.test.ts` › test infrastructure |
| Infra file edited, added or deleted; the same commit after approval | `needs-human`; `exception approve --kind tests-infra` (agent: `agent:<name>`); the report and inbox say `hạ tầng test bị sửa: <path>, duyệt bởi <by>`; a `needs-human` (sensitive file) approval does not settle it; same commit green without a rerun | `exceptions.test.ts` › tests-infra; `assurance.test.ts` › infraCheck |
| Stays-green test that already existed (tester changed nothing) | its file is locked with the rest, so weakening it is red | `codex-review.test.ts` |
| Dependent Multi-WP package | the files its green dependency brought are not its change for `APOS-SCOPE` or `APOS-INFRA` unless modified again | `codex-review.test.ts` |
| Package added or revised without `paths` on a pinned Goal | refused | `codex-review.test.ts` |
| Locked test still failing on the delivery | gate red naming the test | `assurance-gate.test.ts` › is red when a locked test still fails |
| Unit test deleted, or turned into a skip | gate red `test missing` / `test now skipped` | `assurance-gate.test.ts` › is red when a test that existed … |
| Forbidden pattern (`@skip`, `.only`, `# type: ignore`) in an added line | gate red | `assurance-gate.test.ts` › is red for a forbidden pattern … |
| File changed outside the package paths | gate red `APOS-SCOPE` | `assurance-gate.test.ts` › is red for a file outside the package paths |
| Sensitive file changed | `needs-human` (exit 3), not also out of scope | `assurance-gate.test.ts` › needs a human for a sensitive file …; `assurance.test.ts` |
| Exception for the package and commit | same commit green without a new gate run; another commit asks again; logged as `agent:<name>` | `exceptions.test.ts`; `exception-command.test.ts` |
| Exception by a bare name, both `--by` and `--human`, `--human` with no terminal, `floor-reduced`, nothing waiting | refused | `exceptions.test.ts` › refuses what is not waiting …; `exception-command.test.ts` |
| Test renamed in a revision (review focus 4) | treated as deleted: waits for a `tests-weakened` exception, not re-locked | `test-revise.test.ts` › treats a renamed locked test as a deleted one |
| Revision with fewer asserts in a file, or fewer tests for a criterion | waits for the exception | `test-revise.test.ts` |
| Revision that is green on the old code, does not contain the lock, or touches source | refused | `test-revise.test.ts` › refuses a revision that is green on the old code … |
| Revision that keeps ids and asserts | re-locked with `revisionOf`; packages go back to `pending` and must contain the new lock | `test-revise.test.ts` › locks a stronger suite … |
| Goal that pinned no setup, or a setup without `tests.paths` | no `testing` stage, no locked tests, runs as in phases 1 and 2; `goal show` says `không có khoá test` | `lead-commit-plan.test.ts`; `goal-setup-pin.test.ts`; `v3-flow.test.ts` |
| Old log written before phase 3 | replays: `proposal-approved` with no `testing` flag goes to `executing` | `test-lock.test.ts` (domain) › goes to testing only when the Lead's commit says so |

## Cases dropped in phase 1 and why

APOS v2 started, resumed, woke and watched agents through Orca (`controller watch`, Lead dispatch, `handoff`, role profiles, Runs). v3 does none of it: an orchestrator outside APOS does, and APOS only checks the commits it is handed. Every case below existed only because APOS drove agents, so it was removed together with the code it tested. The v2 table is in [`docs/archive/FINAL-DESIGN-v2.1.md`](archive/FINAL-DESIGN-v2.1.md) §8 and in git history.

| Dropped cases | Why they are gone |
| --- | --- |
| Duplicate dispatch, lost CLI response on dispatch or resume, restart then reconcile, Orca outcome unknown or refused on start or resume, Lead dispatch refused, Lead ends its turn early, Lead idle or past its wall time | there is no dispatch, resume, intent or recovery key any more |
| Brief with `$`, quotes or backticks reaching Orca byte for byte; long repair text sent as a note file; resume brief left unsubmitted; Codex input stalled and nudged; screen rules per agent | APOS writes no brief and reads no terminal |
| Owner runs a Human-only command from an APOS terminal or worktree; Human commit on the managed checkout mid-attempt; owner commits into the managed checkout | APOS no longer knows which terminals or worktrees are agents. A Human command now needs a typed confirmation or `--on-behalf` (covered above) |
| Runtime launched another model; missing activation line in the delivery report; owner reports failed with budget left; owner does not know its budget; owner escalation over Orca; same failure after two repairs resumed | APOS neither launches a model nor resumes an owner. A repeated red is an attempt count and a `blocked` Goal (covered above) |
| Reviewer dispatch and recovery, review of the wrong party (owner name or session), review resume after changes, goal review required before integration | no reviewer is started. A review is advice and gates nothing; the warning replaces "review required" (covered above). Real blocking by a red test comes in phase 5 |
| Idle watchdog, `worker_done` for a non-current dispatch, gate finishing after the owner was resumed | no running agent to watch; the last one became "a gate for a package that moved on" (covered above) |
| Telemetry per dispatch, tokens from Codex sessions, model receipts | no dispatch to measure; `metrics show` is submits, red gates and minutes |
| Run ownership, `run-use`, coordinator drift, controller heartbeat | no Run, no controller |
| Lead terminal checks, bot Lead (wake mail, ack, mailbox), Lead transfer, handoff | no Lead dispatch and no bot role |
| A Solo plan needing a second session or the Lead as the one owner; one Lead per Goal version | there is no session to assign. Solo is now the implicit package `WP-MAIN` |
| Goal revised while its Lead runs | there is no running Lead to wait for |

## Not covered by automated tests

- **A malicious local process.** The controller home (`~/.apos`) is outside the owner's worktree and the event log is hash-chained, so edits are detected. The caller runs as the same OS user, so this is tamper-evidence, not a security boundary; `--on-behalf` can be passed by anything that can run the CLI.
- **A delivery that changes or deletes the tests that gate it**, for a Goal with no locked tests (no setup, or a setup without `tests.paths`): only a warning. With locked tests it is red.
- **A weakened test whose assertion count does not fall**, or a stub-test pair that agrees to prove nothing. The count is a line regex; the second net is mutation testing (see [Mutation](../README.md#mutation)).
- **Tests that reach inside the code instead of the declared entries.** Checked only for the stacks whose catalogue has an `entryRule` (Python, TypeScript); not for Java yet.
- **A live run of a Lead and an orchestrator on a real project.** The end-to-end tests drive the CLI on scratch repos.

## Layers by stage, non-functional proof and the assurance table (phase 4)

| Injected fault | Expected | Test |
| --- | --- | --- |
| A floor or triggered layer has no test at that stage (focus 1) | `unverifiable`, the message names the layer (`app.L1 unit: no test ran`) | `layer-gate.test.ts` › a floor layer in which no test ran is unverifiable and names the layer; `layer-verdict.test.ts` › is unverifiable, naming the layer, when no test ran at all |
| A layer fails (exit code, new failure, locked test) | red, the check is `<part>.<layer>.<tool>` | `layer-gate.test.ts` › L0 is an exit-code tool: red on a non-zero exit; `layer-verdict.test.ts` › a locked test must pass even though it was red at the base |
| The Lead adds a layer the setup does not have (focus 2) | `lead commit` refuses and names the layer | `lead-commit-plan.test.ts` › refuses a plan whose Lead-added layer is not in the setup; `layer-plan.test.ts` › layerChoiceProblems |
| The Lead adds layers to a Goal with no setup | refused: nothing would run | `lead-commit-plan.test.ts` › refuses added layers for a Goal that has no setup |
| A benchmark's runs land on both sides of the threshold (focus 3) | `unverifiable`, never the best run | `layer-verdict.test.ts` › is unverifiable when runs land on both sides; `layer-gate.test.ts` › runs on both sides of the threshold are unverifiable |
| A test layer's repeated runs disagree | `unverifiable` | `layer-gate.test.ts` › runs a test layer as many times as the setup says, and flaky results are unverifiable |
| A SARIF finding below `failOn` (focus 4) | not red; the count is on the table | `layer-gate.test.ts` › a SARIF finding below failOn is not red, but its count is kept; `assurance-report.test.ts` › shows what a SARIF layer found below the blocking level |
| A SARIF finding at `failOn` or above | red, names the rule and file | `layer-gate.test.ts` › a SARIF finding at the blocking level is red |
| The integration gate of a Multi-WP Goal runs no layer (focus 5) | it runs the integrate stage on the integration commit; a broken L3 test is red and named | `layers-multi.test.ts` (real pytest and vitest) |
| The integration commit of a Multi-WP Goal edits or deletes a locked test, changes test infrastructure, drops a test, or touches a file no package or plan path covers | red (`APOS-LOCKED`, `APOS-INFRA` needs a decision, `APOS-INVENTORY`, `APOS-SCOPE` naming the file); a refactor's captured tests must pass there too | `integration-gate-checks.test.ts` |
| A package is judged on the locked tests of another package | each package answers only for its own criteria; the Goal for all at integrate and close | `layers-multi.test.ts` |
| A setup threshold looser than the Goal's | the Goal's holds; both must hold | `layer-gate.test.ts` › a setup threshold cannot loosen the Goal |
| A benchmark or scan criterion names a tool the pinned setup lacks or has with another format | `goal approve` refuses, naming criterion and tool | `goal-approve-proof.test.ts` |
| Dropping a floor layer without an exception, or with one for another scope, stage or layer | the layer runs | `layer-plan.test.ts` › reductions; `exceptions.test.ts` › floor-reduced |
| An exception recorded after a gate ran | it never re-judges that gate; it counts for the next | `layer-gate.test.ts` › a floor layer cut by an approved exception … by log order |
| A trigger, the Lead or a criterion names a layer the floor also cuts | it still runs | `layer-plan.test.ts` › cannot cancel what a trigger or the Goal asked for |
| Close with a red close-stage layer | refused, names the layer; an exception on `<goal>:close:<layer>` lets the same commit close | `close-layers.test.ts`; `layer-gate.test.ts` › layers at the close stage |
| Close of a Goal whose close-stage layers never ran | refused | `layer-gate.test.ts` › … refuses to close one whose layers never ran |
| An acceptance test imports an internal module that is not a declared entry | `tests submit` / `revise` refuse, naming file and line | `test-entry-rule.test.ts`; `entry-rule.test.ts` |
| A stack with no entry rule | not checked; the table says "chưa kiểm" | `test-entry-rule.test.ts`; `assurance-report.test.ts` |
| An agent cuts a layer or weakens tests | logged as `agent:<name>`, listed on the table with "agent duyệt thay: n chỗ" | `assurance-report.test.ts` › names who approved each exception; `layers-flow.test.ts` |

## Maintenance Goals: upgrading a dependency, patching a finding (v3.1)

A `maintenance` Goal has no criterion of its own: the gate measures the delivery against the base. These are the cases that try to make it say green when it should not (or red for a defect the base already had).

| Case | What happens | Where it is tested |
| --- | --- | --- |
| A test already red on the base is still red after the upgrade (focus 1) | not a new failure: green, and the table counts it (`lỗi có sẵn trên base: n`) | `maintenance.test.ts` › does not count a failure the base already had, and says how many; `maintenance-flow.test.ts` (real pytest) |
| A test green on the base is red after the upgrade (focus 1) | red, names the test (`new failure(s) vs the base: s::fmt-api`) | `maintenance.test.ts` › is red on a new failure, and names the test; `maintenance-flow.test.ts` |
| The delivery adds a finding the base did not have (focus 2) | red at the blocking level, naming rule and fingerprint; below it, counted only | `maintenance.test.ts` › is red on a new blocking finding, and counts one below the blocking level; `maintenance-flow.test.ts` |
| A finding the base had only moved to another line (focus 2) | not new: the fingerprint ignores the line | `findings.test.ts` › diffFindings; `results.test.ts` › … fingerprint |
| `--security` names a finding the base does not show, or a `ruleId` several findings share (focus 3) | `maintenance open` refuses (`không tái hiện được finding trên base`, or the list to choose from); nothing is written | `maintenance.test.ts` › refuses a finding the base does not show; `findings.test.ts` › matchSecurity |
| `--security` with a setup that has no scan tool, at `open` or at `approve` (focus 3) | refused; a Goal with no `--security` still opens | `maintenance.test.ts` › refuses a security Goal when the setup has no scan tool (both) |
| The delivery of a security Goal still shows the named finding, or no scan judged it (focus 3) | red `APOS-SECURITY` | `maintenance.test.ts` › a security patch is green only when the named finding is gone; `maintenance.test.ts` (domain) › securityCheck |
| The upgrade also edits a source file outside the manifests and `--paths` (focus 4) | red `APOS-SCOPE`, names the file; the scope is the Goal's, whatever the plan's `paths` say | `maintenance.test.ts` › is red when a file outside the manifests and the declared paths changes, and names it |
| A manifest the setup calls sensitive | `needs-human` (exit 3); an agent may approve it and the table lists `agent:<name>` | `maintenance.test.ts` › a sensitive manifest still waits for a decision an agent may give |
| Two runs of a test layer, or two scans, of the same commit differ (focus 5) | `unverifiable` (exit 3), never green or red | `maintenance.test.ts` › is unverifiable when two runs of a test layer disagree; … when two scans of the delivery show different findings |
| The base scan is run again at every submit | it is not: it is recorded in the Goal when it is opened, and reused while the plan's base holds the same project (nothing but `.apos/` differs) | `maintenance.test.ts` › scans the base once |
| A pull request (`--from-pr`) that does not contain the Goal's base (focus 6) | refused: `rebase the change onto it` | `maintenance-pr.test.ts` › refuses a pull request that does not contain the base of the Goal |
| The remote moves the pull request after the Goal recorded its sha | `--from-pr` refuses and asks for `--commit`; the package stays pending | `maintenance-pr.test.ts` › refuses when the remote moved the pull request |
| `--from-pr` and `--commit` together, neither, or `--from-pr` on a Goal not opened from a pull request | refused | `maintenance-pr.test.ts` › needs exactly one of --commit and --from-pr |
| A maintenance Goal with a criterion or a check written by hand | refused at creation | `maintenance.test.ts` (domain) › refuses a criterion or a check written by hand |
| `maintenance approve` on another kind of Goal, or without a Human | refused, nothing written | `maintenance.test.ts` › refuses a Goal that is not a maintenance Goal; … approves, sets the default appetite and selects with one confirmation |
| A plan (`lead propose --file`) with `stubPaths`, or a setup with no manifests, tries to widen what a maintenance Goal may change | `lead commit` refuses the stub paths; `approve` refuses a setup with no manifests; at the gate the scope is the Goal's alone (an empty scope means nothing may change) | `maintenance.test.ts` › what the Goal may change cannot be widened by the plan or the setup |
| A scan that did not run to the end, or whose two runs differ only in a finding's severity | `unverifiable`, not red: no attempt is spent | `maintenance.test.ts` › is unverifiable, not red, when a scan of a security Goal does not agree with itself; … two scans agree on a finding but not on its severity |
| The base's test tool breaks (timeout, no readable report) while the delivery's runs | `unverifiable`, not red: with no base there is nothing to call "new" | `maintenance.test.ts` › is unverifiable when the base gives no readable result |
| The setup changed the scanner between `open` and the delivery | the recorded base scan is not reused (it stands for one command); the base is scanned again | `maintenance-gate.test.ts` › scans the base again when the setup changed the scanner |
| The second of the two base runs exits non-zero while its report shows the same passing tests | `unverifiable` (a base run that is not clean is not a base) | `maintenance.test.ts` › is unverifiable when the second run on the base exits badly with the same tests passing |
| The base's tests never load (a collection or import error in a readable report) | `unverifiable`: failures the delivery shows are not called new | `maintenance.test.ts` › is unverifiable when the base reports tests that never loaded |
| A security Goal closed under a setup whose close floor has no L5 | the named finding's scan is still scheduled at close (`requiredTools`), so the Goal closes with `APOS-SECURITY` in the close gate | `maintenance.test.ts` › closes a security Goal even when the floor of the close stage has no L5 |
| The upgrade makes a test of the base disappear, or skip, in any test layer | red, names the test: "not run any more" (the inventory of L1 also catches it; this covers L2 and L3) | `maintenance.test.ts` › is red when the upgrade makes a test of the base disappear or skip, and names it |
| Two findings of different rules or files share a SARIF `partialFingerprints` value (a line hash) | not the same finding: the fingerprint carries the rule and the path | `findings.test.ts` › does not let two rules, or two files, share a partial fingerprint |
| A test is missing in one delivery run of a layer and back in the other | `unverifiable` (the runs disagree), not red for lost coverage | `maintenance.test.ts` › is unverifiable, not red, when a test is missing in one delivery run and back in the other |

## Removing a feature: a `removed` criterion and the tests that go with it (v3.1)

A Goal with a `removed` criterion may lose the tests it declared (`removesTests`, approved with the Goal) and no other. These are the cases that try to lose one more, lose one fewer, or prove the removal with a test that proves nothing.

| Case | What happens | Where it is tested |
| --- | --- | --- |
| The delivery deletes one more test than the Goal declared, locked or not (focus 1) | red `APOS-INVENTORY`, names the test (`test missing: app.L1::tests.test_cart::test_an_empty_cart_totals_zero`) | `removal-gate.test.ts` › is red, naming the test, when one more test than declared is gone; `assurance.test.ts` › inventoryCheck with declared removals; `npm run demo:remove` |
| A declared test (an id, or a file) is still run by the delivery, or only skipped (focus 2) | red, `declared removed but still there: <test>` | `removal-gate.test.ts` › is red when a declared test is still there, by file or by id; `npm run demo:remove` |
| A declared entry matches no test on the base at the gate | red, `declared removed but not on the base: <entry>` | `assurance.test.ts` › is red for a declared test the base does not have |
| A declared file keeps reporting a test under a new name (a rename, another parameterization) | red, `declared removed but still there: <test>`: the entry is checked against the delivery's tests, not only the base's | `assurance.test.ts` › is red for a test under a declared file that the base did not have |
| `removesTests` names a test, a file, a part or a layer the base does not have (focus 3) | `goal approve` refuses and lists every one (`no such test on the base`, `the base has no test run for web.L1`); nothing is written | `removal-approve.test.ts` › refuses a declared test the base does not have, and lists every one; `removal.test.ts` › removalProblems |
| `goal approve` of a Goal that removes tests | prints each declared test with the tests it matches on the repo as it is, before the Human confirms | `removal-approve.test.ts` › prints the tests that will go |
| The test of absence is red because of an error: a load error, `ImportError`, `AttributeError`, `TypeError`, "not implemented", whether the runner calls it an error or a failure (focus 4) | `tests submit` refuses: `the test did not load`, or `must fail on an assertion while it is still there` (the first line of the message is read: pytest reports an exception in a test body as a failure) | `test-lock-removal.test.ts` › refuses a test that is red because the code it imports is not there; … an error that says "not implemented"; `test-lock.test.ts` › refuses a removed test that failed with an exception that is not an assertion; `removal-flow.test.ts` (real pytest: an import and a call of a missing name inside the body, a module-level import of a missing module) |
| The test of absence is in the same file as a test the Goal declares removed | `tests submit` refuses: locking the file would lock the old tests, which could then be neither kept nor deleted; use a file of its own | `test-lock-removal.test.ts` › refuses a test of absence that sits in a file with a declared old test |
| The Tester's commit of a Goal whose test-proved criteria are all `removed` changes code, a stub or test infrastructure | `tests submit` refuses, naming the file (`removal: the Tester adds tests only`): the feature must be there, as it is, for the test of absence to be red | `test-lock-removal.test.ts` › refuses a Tester commit that changes anything but tests; `removal-flow.test.ts` |
| The test of absence is already green (the feature is gone, or the test never asks for it) | `tests submit` refuses: `already green: the feature is gone already, or the test never asks for it` | `test-lock-removal.test.ts` › refuses a test that is already green |
| The old tests are deleted and the feature is not | red `APOS-LOCKED`: the test of absence is still red | `removal-gate.test.ts` › is red while the test of absence is red |
| Another Goal's locked test (a characterize Goal's too) is among the declared (focus 5) | allowed; the table says `xoá đúng n test đã khai (k test đã khoá của GOAL-…)` | `removal-gate.test.ts` › lets them go when declared, and the table says whose they were; `assurance-report.test.ts` › the table of a Goal that removes a feature |
| Another Goal's locked test goes and is not declared (focus 5) | red, names the test | `removal-gate.test.ts` › does not let them go when only the other tests are declared |
| A declared test lives in a layer the floor does not run (L2, L3, L4) | its layer is run on the base and the delivery anyway, so "still there" is seen | `removal-gate.test.ts` › finds a declared test in a layer the floor does not run |
| A Goal with no `removed` criterion loses a test | red, as before (the old rule is unchanged) | `removal-gate.test.ts` › is red for a Goal that declares nothing |
| A Multi-WP Goal's integration commit, or the close stage, drops one more test, or keeps a declared one (focus 6) | the same inventory, over every declared entry of the Goal: red, names it | `removal-gate.test.ts` › at the integrate stage / at the close stage |
| A refactor after a removal that deleted tests of a closed characterize Goal | the removed tests are not required evidence; the files the removal changed are held as it left them; a removal older than the lock changes nothing | `characterized-gate.test.ts` › coverageOfRefactor after a Goal that removed tests |
| A removal that took none of a characterize lock's tests but edited a captured test it kept | the lock is not adjusted: the refactor's `APOS-CHARACTERIZED` still holds the file to what was locked | `characterized-gate.test.ts` › leaves a lock alone when the removal took none of its tests |
| A `removed` criterion without `removesTests`, `removesTests` on another proof, an entry that is not `<part>.<layer>::<id>`, or `removed` in a bugfix, characterize or refactor Goal | refused at creation | `removal.test.ts` › removed criterion |
| A Goal that declares tests but has no approved setup | `goal approve` refuses: the tests are named through the layers of a setup | `removal-approval.ts` (no setup) |
| A Multi-WP package builds on a green package that already removed tests | those tests are not this package's loss: the entries of green dependencies the delivery contains are allowed too (never an unrelated package's) | `removal-gate.test.ts` › a Multi-WP package that builds on a package which already removed tests |
| A removal closes after the refactor's base was pinned, or on a branch the base does not contain | the refactor still requires the tests, as locked: only removals the base holds count | `characterized-gate.test.ts` › ignores a removal the refactor base does not contain |
| Two removals took different tests out of the same captured file, and their Goal ids sort the other way round | applied in the order of their commits: the newest removal's file stands | `characterized-gate.test.ts` › applies removals in the order of their commits |
| A test of absence fails with Jest's `Error: expect(received).toBe(expected)` | an assertion: accepted (only other exception classes are refused) | `test-lock.test.ts` › accepts a removed test that failed an assertion |
| Two characterize locks share a test file and a removal took a test of only one of them | the file's post-removal version is held for both locks, each keeps its surviving tests | `characterized-gate.test.ts` › holds a file two characterize locks share as the removal left it |
| A removal deletes a test of one captured file and weakens a kept test in another | only the file that held a removed test is rehashed; the other stays held to what was locked | `characterized-gate.test.ts` › rehashes only the files that held a removed test |
| A test of absence crashes with a runner-reported exception class (vitest `type="TypeError"`) | refused: the reported class is believed over the message | `test-lock.test.ts` › believes the exception class a runner reports |
| A removal's module path exists in two parts of the same lock (`api/tests/test_calc.py`, `web/tests/test_calc.py`) | the lock cannot say which one lost the test: neither file is rehashed, both stay held to what was locked | `characterized-gate.test.ts` › adjusts neither file when two parts have the same module path |

## Hotfix: letting a fix through now and owing the evidence (v3.1)

`apos hotfix` lets the Human merge a fix before any gate has seen it. APOS merges nothing and holds nothing up; it records the hotfix, opens the bugfix Goal that owes the evidence by a deadline, and does not let the debt be forgotten. These cases try to skip the Human, to prove the wrong code, or to make the debt disappear.

| Case | What happens | Where it is tested |
| --- | --- | --- |
| An agent runs `apos hotfix` with no terminal and no `--on-behalf` (focus 1) | refused (`hotfix is a Human decision`), nothing written; `hotfix` is in the Human commands of the `AGENTS.md` block, which a test checks against every `assertHuman` in the CLI | `hotfix.test.ts` › is a Human command: an agent with no terminal and no --on-behalf is refused and nothing is written; `agents-md.test.ts` › names every command guarded by assertHuman in the block; `npm run demo:hotfix` |
| The hotfix commit is a merge commit, or has no parent, and no `--before` (focus 2) | refused: say which commit is "before" the hotfix | `hotfix.test.ts` › a merge commit is refused unless --before names an ancestor of it; › a root commit has no parent …; `hotfix-flow.test.ts` (real pytest, merge commit) |
| `--before` is not a commit, is the hotfix itself, or is not an ancestor of it (focus 2) | refused, nothing written | `hotfix.test.ts` › a merge commit is refused …; › a root commit has no parent … |
| `--due` without a unit (`24`), half a Given/When/Then, no `--commit`, the same hotfix twice | refused | `hotfix.test.ts` › refuses a due without a unit, half a Given/When/Then, a missing commit and the same hotfix twice |
| The Tester's test is green on the commit before the hotfix (focus 3) | `tests submit` refuses: `test không tái hiện lỗi` (the plan's base is that commit, and the bugfix rule is unchanged) | `hotfix-evidence.test.ts` › refuses a test that is green on the commit before the hotfix, and locks one that is red there; `npm run demo:hotfix` |
| A plan for a hotfix Goal starting from another commit (`--base`, or a plan file) | refused: the plan starts from the commit before the hotfix | `hotfix-evidence.test.ts` › is refused a base other than the commit before the hotfix |
| The delivery does not contain the hotfix commit, though its locked test is green (focus 4) | red `APOS-HOTFIX`, names the commit and says to merge it into the tests commit | `hotfix-evidence.test.ts` › goes green only on a delivery that contains the hotfix commit …; `hotfix-flow.test.ts` (real pytest); `npm run demo:hotfix`; `hotfix.test.ts` (domain) › the delivery of a hotfix |
| The delivery also changes code the hotfix did not change (focus 4) | red `APOS-SCOPE`, names the file (the plan's `paths` are the files the hotfix changed) | `hotfix-evidence.test.ts` › is red when the delivery changes code outside what the hotfix changed |
| A revision of the Goal drops, adds or changes the link to the hotfix (and so the deadline) | refused at `goal revise`; the hotfix record survives every revision | `hotfix.test.ts` (domain) › survives a revision of the Goal, which cannot add, drop or change the link |
| The deadline passes with no evidence (focus 5) | `apos inbox` has a `needs-decision` line `hotfix <sha> quá hạn <absolute deadline>, chưa có bằng chứng`; the text does not change as time passes (so `--wait` does not fire again and again) | `hotfix-inbox.test.ts` › turns red once the deadline has passed, and says the same thing on every call; `npm run demo:hotfix` |
| The hotfix waits inside its deadline | an ordinary notice with the deadline; with any hotfix without evidence, `hotfix chưa có bằng chứng: n` in `apos inbox` and at the top of `apos goal show` of every Goal | `hotfix-inbox.test.ts` › shows a hotfix that waits …; › opens every Goal with the count … |
| The Goal is closed with a green gate (focus 5) | the hotfix is `có bằng chứng`, its lines and the count go away, the table says the test, red on the commit before and green with the hotfix | `hotfix-evidence.test.ts` › goes green only on a delivery that contains the hotfix commit …; `npm run demo:hotfix` |
| The Goal is stopped (`outcome stop`) (focus 5) | the overdue line goes, the count stays, `hotfix list` says `bỏ dở`, the table says the hotfix stays without evidence for good | `hotfix-inbox.test.ts` › a hotfix that is stopped … |
| L0 or L1 is red on the hotfix commit (focus 6) | recorded in `hotfix-gated`, the hotfix is accepted all the same; the inbox line adds `hotfix đỏ ở L1` | `hotfix.test.ts` › says in the log when L1 is red on the hotfix, and does not hold the hotfix up; `hotfix-inbox.test.ts` › adds "hotfix đỏ ở L1" … |
| The project has no approved setup, or another gate holds the lease | the hotfix is accepted; the log says L0 and L1 did not run, and why | `hotfix.test.ts` › takes the check from --check when the project has no setup, and says no layer ran |

## What the table does not claim (v3.2 T0, #50)

Every assurance table ends with the same `Giới hạn` line: the Human confirmation is a guard against mistakes and not a security boundary (any process that can run `apos` can pass `--on-behalf`), `--by agent:<x>` is the caller's own word, and APOS proves the code meets the approved criteria, not that the criteria or tests are enough. The gate does not change; the words are in the README (Limits › What the evidence does not prove) and tested in `assurance-report.test.ts` › the Limits line.
