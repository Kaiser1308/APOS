# APOS v2 safety cases (FINAL-DESIGN §8)

Threshold: **0 false verification, 0 duplicate dispatch, 0 unauthorized merge.** Human gates are enforced against agent terminals and worktrees, not against a local process deliberately impersonating the Human. Every case below is an automated test. Run them with `npm test`.

| Injected fault | Expected | Test |
| --- | --- | --- |
| Owner claims `pass`, no gate ran | not verified | `verification.test.ts` › rejects a self-declared pass when the controller has not run the gate |
| Owner claims `pass`, gate red | not verified | › rejects a red gate even when the owner reported pass |
| Wrong log / artifact | the gate writes its own logs and hashes them outside the repo; owner artifacts are never read as proof | `gate.test.ts` › goes green … with logs hashed outside the repo |
| Stale commit: gate on X, review or merge of Y | refused | `verification.test.ts` › rejects a green gate that ran on a different commit; `merge.test.ts` › merges only the gated commit; `v2-rules.test.ts` + `review.test.ts` (review must name the gated commit) |
| Gate finishes after the owner was resumed | gate rejected | `verification.test.ts` › rejects a gate that finishes after the owner was resumed |
| Uncommitted files in the owner tree | not counted | `gate.test.ts` › runs in a clean checkout |
| Delivery not descended from base | refused | `gate.test.ts` › refuses a delivery commit that does not descend from the base |
| Review by the wrong party | refused: the owner's name, the owner's session, or a review without a session | `review.test.ts`; `v2-rules.test.ts` › rejects a reviewer reusing the owner session; `packages.test.ts` › requires a different reviewer |
| Tests, oracles, check-run files or build manifests changed | review required | `v2-rules.test.ts` › requires review when the gated diff changes tests |
| New failing test | red, names the test | `gate.test.ts` › goes red and names the test the delivery newly broke |
| Base red, or baseline cannot run | `unverifiable`, never green; Solo goes to needs-decision | `gate.test.ts` › is unverifiable when the baseline suite cannot run; `gate.test.ts` (domain) › is unverifiable … |
| Flaky or hung check | `unverifiable`; process tree killed and workspace removed | `domain/gate.test.ts` › repeated runs disagree or a run times out; `gate.test.ts` › kills a hung check at its timeout |
| Dispatch not settled | no resume or verify | `solo.test.ts` › does not reuse a live terminal; `packages.test.ts` › does not verify a package while its Orca Worker is still live |
| Lost CLI response on dispatch or resume | recovered by dispatch key, no second worker | `packages.test.ts` › recovers an unknown dispatch …; `solo.test.ts` › recovers a lost phased resume response; `orca.test.ts` › recovers … |
| Restart, then reconcile | no duplicate dispatch | `controller.test.ts` › releases dependency-ready Workers after a restart without duplicate dispatch |
| Brief containing `$`, quotes or backticks | reaches Orca byte for byte (no shell) | `fault-injection.test.ts` › brief with $ and quotes |
| Source changed after approval | approval and gate refused; editing the repo copy changes nothing | `cli.test.ts` › refuses approval when the source snapshot was edited; `gate.test.ts` › refuses to gate when the controller source snapshot changed |
| Requirement left unmapped, or an open question | Goal not approvable; plan not dispatched | `contracts.test.ts` › Goal approval readiness; `cli.test.ts` |
| Plan against another source, or over appetite | not dispatched (`needs-decision`) | `v2-rules.test.ts` › No Human gate on HOW … |
| Merge without authorization | refused | `verification.test.ts` › does not infer merge permission; `merge.test.ts` |
| Target branch moved after verification | gated commit merged, gate rerun on the merge; red keeps the Goal open | `fault-injection.test.ts` › target branch head moved after verification |
| Event log edited or forged | reported, not trusted; a torn tail from a crash is dropped | `project-history.test.ts` › reports an edited or forged event; › drops a torn final line |
| Goal events committed into the repo by an owner | ignored | `journal.test.ts` › ignores Goal events an owner commits into the repo |
| Delivery rewrites an APOS skill, Goal document or source in the repo | gate red (`APOS-PROTECTED`); the reviewer skill is pinned at the base commit | `gate.test.ts` › fails the gate when the delivery rewrites an APOS-managed file |
| Lost SQLite index | rebuilt from the controller log | `journal.test.ts` › rebuilds a lost SQLite index |
| Core skill not loaded (no activation line) | finding; same owner resumed | `supervisor.test.ts` › does not accept a delivery whose report lacks the core activation line |
| Runtime launched another model | needs-decision | `supervisor.test.ts` › stops for a decision when the runtime launched a different model |
| Same failure after two repairs | needs-decision | `supervisor.test.ts` › sends the Goal to a Human decision when the same failure survives two repairs |
| Owner commits into the managed checkout instead of its worktree (seen live) | needs-decision | `supervisor.test.ts` › stops for a decision when the owner commits into the managed checkout |
| Codex leaves the brief pasted but unsubmitted (seen live, owners and reviewers) | the screen is read; Enter up to 3 times a minute apart from the first quiet minute; then the Human; a visibly working agent is never reported | `supervisor.test.ts` › stalled Codex input |
| An owner runs a Human-only command (merge, approve, appetite, confirm, unblock) | refused from any agent terminal or worktree | `cli.test.ts` › refuses Human-only commands from an APOS agent terminal |
| A Human commit on the managed checkout mid-attempt | not flagged | `supervisor.test.ts` › does not block a Goal for an ordinary Human commit |
| Orca refuses a resume (`agent_unconfigured`, seen live) | intent abandoned, retried; needs-decision after 3 refusals | `supervisor.test.ts` › Orca refusing a resume |
| Orca outcome unknown on start or resume (seen live) | recovered by dispatch key, never retried blindly; Human notified after 10 min | `supervisor.test.ts` › Orca refusing a resume; `solo.test.ts` › recovers a lost … response |
| Resume continues a cumulative Codex session (seen live) | tokens attributed per dispatch | `telemetry.test.ts` |
| Owner reports failed with budget left (seen live, SQLFMT pilot: stopped at 15 of 90 min) | same owner resumed with its own `## Remaining` list; stops when attempts or wall time are spent, or when there is no report | `supervisor.test.ts` › owner stops early |
| Owner does not know its budget (seen live) | brief states minutes and attempts left | `brief.test.ts` |
| Owner escalates over Orca mid-attempt and waits (seen live: fixture vs approved criterion) | Human notified once, owner answered with the standing rule, delivery acked | `supervisor.test.ts` › notifies the Human of an owner escalation once |
| Orca creates the reviewer but reports its start as outcome-unknown (seen live, SQLFMT run 2) | `review-intended` recorded first; reviewer recovered by dispatch key; new try after 3 min; needs-decision after 3 | `supervisor.test.ts` › recovers a reviewer Orca created |
| Resume refused after a review asks for changes on a green gate (seen live, SQLFMT run 2: Goal sat 26 min) | the bounded retry runs before the green-gate early return | `supervisor.test.ts` › retries a refused resume after a review asks for changes |
| Resume brief left unsubmitted in a reused Codex terminal, reported as pending / turn_start_unobserved (seen live, SQLFMT run 2) | counted as stalled input, so the one-Enter nudge applies | `orca.test.ts` › treats a resume whose brief sits unsubmitted |
| Long repair or wake-up text (seen live: 7.8k-char brief never submitted) | text over 400 chars goes to `<controller home>/notes/<key>.md`; the brief carries path and sha256 | `orca.test.ts` › writes a long repair finding to a note file |
| Review JSON written with a UTF-8 BOM by PowerShell (seen live) | BOM stripped before parsing | `supervisor.ts` collectReview |
| Goal idle with no agent running and no controller progress (seen live: 26 min, silent) | `human-notified` kind `idle` once per quiet spell after 15 min | `controller.test.ts` › idle watchdog |
| A new failure that does not reproduce (seen live: two gates on one commit, `test_run_with_callback`) | one fresh delivery rerun; only failures seen twice count as new | `gate.test.ts` › does not go red on a new failure that does not reproduce |
| Two controller loops on one project (seen live: a loop thought stopped kept ticking) | one tick at a time per controller home; a dead holder's lease is cleared | `lease.test.ts` |
| Intent gap found during execution | Goal parked for PM and Human | `v2-rules.test.ts` › parks the Goal for PM and Human on an intent gap |

## Not covered by automated tests

- **A malicious local process.** The controller home (`~/.apos`) is outside the owner's worktree, and the event log is hash-chained, so edits are detected. The owner still runs as the same OS user, so this is tamper-evidence, not a security boundary.
- **The real Orca and Codex path.** It needs a live smoke run; see the README.
