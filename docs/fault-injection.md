# APOS v2 safety cases (FINAL-DESIGN §8)

Threshold: **0 false verification, 0 duplicate dispatch, 0 unauthorized merge.** Every case below is an automated test. Run them with `npm test`.

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
| Tests or oracles changed without review | review required | `v2-rules.test.ts` › requires review when the gated diff changes tests |
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
| Lost SQLite index | rebuilt from the controller log | `journal.test.ts` › rebuilds a lost SQLite index |
| Core skill not loaded (no activation line) | finding; same owner resumed | `supervisor.test.ts` › does not accept a delivery whose report lacks the core activation line |
| Runtime launched another model | needs-decision | `supervisor.test.ts` › stops for a decision when the runtime launched a different model |
| Same failure after two repairs | needs-decision | `supervisor.test.ts` › sends the Goal to a Human decision when the same failure survives two repairs |
| Intent gap found during execution | Goal parked for PM and Human | `v2-rules.test.ts` › parks the Goal for PM and Human on an intent gap |

## Not covered by automated tests

- **A malicious local process.** The controller home (`~/.apos`) is outside the owner's worktree, and the event log is hash-chained, so edits are detected. The owner still runs as the same OS user, so this is tamper-evidence, not a security boundary.
- **The real Orca and Codex path.** It needs a live smoke run; see the README.
