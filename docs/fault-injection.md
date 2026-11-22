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
| A review says `changes` | recorded as advice; gates nothing | `v2-rules.test.ts` › records a review as advice only; `integration.test.ts` › no longer needs a review to integrate |

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
- **A weakened test whose assertion count does not fall**, or a stub-test pair that agrees to prove nothing. The count is a line regex; the second net is mutation testing (phase 5).
- **Tests that reach inside the code instead of the declared entries.** Not checked until the catalogue has a rule per stack (phase 4).
- **A live run of a Lead and an orchestrator on a real project.** The end-to-end tests drive the CLI on scratch repos.
