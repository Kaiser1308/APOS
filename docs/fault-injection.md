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
| Tests, oracles, check-run files or build manifests changed | **warning in the gate report, the inbox and the UI; not blocked** (no test lock until phase 3: a known gap) | `v2-rules.test.ts` › warns when the gated diff changes tests …; `inbox.test.ts` › shows the warnings a gate report carries |
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
| Tool that does not exist, times out, or gives different results on two runs | probe fails with the reason | `setup-probe.test.ts` |
| Part whose stack is not recognised | draft still produced, part empty, note `chưa nhận ra stack` | `setup-draft.test.ts` |
| Delivery edits `.apos/project.yaml` | gate red, `APOS-PROTECTED` | `gate-service.test.ts` › fails the gate when the delivery edits the approved setup |
| Goal pinned to a setup version that was never approved | refused | `goal-setup-pin.test.ts`; `journal.test.ts` |
| Setup approved after a Goal was approved | the Goal keeps its pinned version | `goal-setup-pin.test.ts` |
| Approving without a terminal and without `--on-behalf` | refused | `setup-flow.test.ts` |

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
- **A delivery that changes or deletes the tests that gate it.** Only a warning until test locking (phase 3).
- **A live run of a Lead and an orchestrator on a real project.** The end-to-end tests drive the CLI on scratch repos.
