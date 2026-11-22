> **Lưu trữ (lịch sử).** Kế hoạch của APOS v2, mô tả tầng điều phối agent đã bị bỏ ở v3 đợt 1. Không mô tả code hiện hành.

# GitHub Issues #2–#13 Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the places where a Goal sits silently or an agent cannot act, as reported in Kaiser1308/APOS issues #2–#13.

**Architecture:** Most issues share two root causes. (1) The controller only reads the Orca run inbox while a Goal is `executing`/`blocked`, and only relays owner messages in Solo, so Lead questions, quota escalations during planning and Multi-WP messages never reach `apos inbox`. (2) A wake or tick failure on a dead session is swallowed or repeated instead of becoming a notice or a fresh dispatch. The rest are small, independent CLI/doc fixes.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, commander CLI, Orca CLI adapter (`src/runtime/orca.ts`).

**Spec:** GitHub issues #2–#13 (`gh issue view <n>`); existing design in `docs/design/multi-agent-roles.md`.

## Global Constraints

- Every behaviour change lands with a failing test first (`npx vitest run <file>`), then the fix; run `npx vitest run` and `npx tsc --noEmit` before each commit.
- Notices are `human-notified` events read by `buildInbox` (`src/app/inbox.ts`); do not add a second notice channel.
- One notice per cause, deduplicated by `messageId` / `dispatchId` (same convention as `recordExhausted` and `notifyOnce`).
- User-facing error text in English; keep existing `Human decision` guards (`assertHuman`).
- Commit messages follow the repo style (`fix: ...`), one commit per task.

## Review Focus

- Lead asks a question while the Goal is `selected` (before any plan) → notice in inbox, not auto-answered.
- Quota escalation arrives while the Goal is `selected`/`planned`/`ready` (not only `executing`) → `agent-exhausted` notice.
- A Multi-WP Lead or Worker message (not Solo) is neither dropped nor auto-replied "keep working".
- Tick error that repeats on consecutive passes surfaces once in the inbox, not once per tick.
- `lead wake` on a Lead whose terminal is dead must not say "still in its turn".

## File Map

| File | Responsibility change |
|---|---|
| `src/app/controller.ts` | read run inbox in all active statuses; relay Lead/Multi messages; repeated-error notice |
| `src/app/lead.ts` | `wake` decides "in its turn" from the runtime, fresh-Lead fallback on `session_caller_not_live` |
| `src/app/supervisor.ts` | Multi-WP wake falls back to a fresh Lead |
| `src/runtime/brief.ts` | one `aposCommand(repoPath)` used by every brief |
| `src/app/integration.ts`, `README.md`, `skills/apos-lead/SKILL.md` | integration input schema: all-errors-at-once + docs |
| `src/cli-app.ts` | empty-state output, `goal select` profile print, sha256 error text |
| `src/ui/activity.ts` | transcripts that contain only an error |
| `scripts/promote-skills.mjs` | `--check` without a dev dir |

---

### Task 1: Controller reads the run inbox during planning (#3, #5)

**Files:**
- Modify: `src/app/controller.ts` (`consumeInbox`, status guard at the top; `OWNER_MESSAGES` branch)
- Test: `src/app/controller.test.ts`

**Interfaces:**
- Consumes: `quotaEscalation`, `ownerOf`, `recordExhausted` from `src/app/watch.ts`; `GoalState.lead` (`current`, `ref.runId`).
- Produces: `human-notified` event `{ kind: 'lead-question', goalId, messageId, messageType, subject, body, note }` for any `question|escalation|decision_gate|blocker` message from a Lead whose plan is not accepted or in Multi-WP; no `replyMessage` is sent for it.

- [ ] **Step 1: Write failing tests** in `controller.test.ts`:
  - `relays a Lead question to the inbox while the Goal is selected`: Goal `selected` with `lead.ref.runId`, fake `checkRun` returns one `question` message → `buildInbox` contains a `notice` with `kind: 'lead-question'`; `replyMessage` not called; second tick adds no duplicate.
  - `records agent-exhausted for a quota escalation while the Goal is selected`: fake `checkRun` returns Orca's escalation (`subject: 'Agent hit an error: Codex hit its usage limit.'`, `dispatchId` = lead dispatch) → one `agent-exhausted` notice with `role: 'lead'`.
  - `does not auto-reply to a Multi-WP Worker question`: mode `multi-wp`, `question` message → `lead-question` notice, no reply.
- [ ] **Step 2: Run** `npx vitest run src/app/controller.test.ts` → the three new tests FAIL.
- [ ] **Step 3: Implement** — in `consumeInbox` accept statuses `['selected','planned','ready','executing','blocked']`; take `runId` from `state.lead?.ref.runId` when no `runtimeRef`/package refs exist. Replace the `inboxPending.push` fallthrough for owner-type messages with `relayToHuman(goalId, message)` (the notice above, deduplicated by `messageId`); keep Solo's existing `relay` (with `ESCALATION_REPLY`) only for `proposal.mode.startsWith('solo')` and an accepted plan. Ack the delivery once every message is handled.
- [ ] **Step 4: Run** the file again → PASS; run `npx vitest run src/app` for regressions.
- [ ] **Step 5: Commit** `fix: surface Lead questions and quota escalations during planning in apos inbox`

### Task 2: Human can answer a waiting Lead (#3 follow-up)

**Files:**
- Modify: `src/app/lead.ts` (`wake`), `src/cli-app.ts` (`lead wake` help text)
- Test: `src/app/lead.test.ts`

**Interfaces:**
- Consumes: `RuntimeAdapter.inspect`, `replyMessage` (optional) from Task 1's message ids.
- Produces: `LeadService.wake(goalId, repoPath, note)` additionally accepts a Lead that is waiting on an unanswered Orca message: it replies to that message with the note (via `replyMessage`) instead of throwing.

- [ ] **Step 1: Write failing test** `lead wake answers the pending question instead of refusing`: Lead not settled, a `lead-question` notice with `messageId` exists, `replyMessage` fake → `wake` resolves, `replyMessage` called with `(runId, messageId, note)`.
- [ ] **Step 2: Run** `npx vitest run src/app/lead.test.ts` → FAIL ("still in its turn").
- [ ] **Step 3: Implement** — in `wake`, before the `!state.lead.settled` throw, look up the latest unanswered `lead-question` notice (no later `lead-answered` event); if found and `runtime.replyMessage` exists, reply, append `lead-answered`, return the current dispatchId. Add `lead-answered` to `GoalEventType` only if the event union is closed (`src/domain/transitions.ts`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: lead wake answers a pending Lead question`

### Task 3: Dead-session wake falls back to a fresh Lead (#12, #13)

**Files:**
- Modify: `src/app/lead.ts` (`wake`), `src/app/supervisor.ts` (`MultiSupervisor.step` wake path), `src/app/controller.ts` (tick error handling)
- Test: `src/app/lead.test.ts`, `src/app/multi-supervisor.test.ts`, `src/app/controller.test.ts`

**Interfaces:**
- Consumes: `OrcaRefused` (`src/runtime/orca.ts`, `.code`), handoff service entry used by `apos handoff` (`src/app/handoff.ts`).
- Produces: `isDeadSession(error: unknown): boolean` exported from `src/runtime/orca.ts` — true for `OrcaRefused` with code `session_caller_not_live`; controller notice `{ kind: 'tick-error', goalId, error, note }` recorded once per distinct error text.

- [ ] **Step 1: Reproduce first.** Read `OrcaRefused` construction in `orca.ts` to confirm `session_caller_not_live` reaches the caller as `OrcaRefused.code`. Write the three failing tests: (a) `multi-supervisor wake starts a fresh Lead when the wake fails with session_caller_not_live` (expects a handoff-style `lead-started`/`owner-handed-off` event, no thrown error); (b) `lead wake does not report "still in its turn" when inspect shows the Lead dispatch has ended` (fake `inspect` returns `outcome`; `settled` still false) → wake proceeds; (c) `three consecutive identical tick errors produce one tick-error notice`.
- [ ] **Step 2: Run** the three test files → FAIL.
- [ ] **Step 3: Implement** `isDeadSession`; in the Multi-WP wake path catch it and call the same handoff routine as `apos handoff <goal>` (current role profile); in `LeadService.wake` decide "in its turn" from `runtime.inspect(currentLeadRef(lead))` (`outcome === undefined` and terminal live) rather than only `lead.settled`; in `ControllerService` keep a per-goal last-error map and append `tick-error` after the 2nd identical error.
- [ ] **Step 4: Run** `npx vitest run src/app` → PASS.
- [ ] **Step 5: Commit** `fix: dead-session wake starts a fresh Lead; repeated tick errors reach the inbox`

### Task 4: Agents get a runnable APOS command (#2)

**Files:**
- Modify: `src/runtime/brief.ts` (all `apos --repo "..."` occurrences), `src/cli.ts` or `src/cli-app.ts` (where the controller knows its own entry)
- Test: `src/runtime/brief.test.ts`

**Interfaces:**
- Produces: `aposCommand(repoPath: string, entry?: string): string` in `brief.ts`, returning `node "<abs path to dist/cli.js>" --repo "<repoPath>"`; `entry` defaults to the path of the running CLI (`fileURLToPath(new URL('../cli.js', import.meta.url))`), so briefs work without `npm link`.

- [ ] **Step 1: Write failing tests**: `aposCommand returns node + absolute cli path + --repo`; `handoffBrief and leadWakeBrief contain aposCommand, not a bare "apos --repo"`.
- [ ] **Step 2: Run** `npx vitest run src/runtime/brief.test.ts` → FAIL.
- [ ] **Step 3: Implement** `aposCommand` and replace the literal `apos --repo "${...}"` / `apos handoff` strings in briefs and in the skills' command hints (`skills/apos-*/SKILL.md`: say "run the command given in your brief"). Human-facing notices keep plain `apos` (the Human has it).
- [ ] **Step 4: Run** `npx vitest run` → PASS (update snapshot-style brief tests that hard-code `apos --repo`).
- [ ] **Step 5: Commit** `fix: briefs carry an absolute APOS command so agents need no PATH entry`

### Task 5: Integration input documented and fully validated (#11)

**Files:**
- Modify: `src/app/integration.ts`, `README.md` (CLI table + Multi-WP section), `skills/apos-lead/SKILL.md`, `src/runtime/brief.ts` (Multi-WP lead brief)
- Test: `src/app/integration.test.ts`

**Interfaces:**
- Produces: `parseIntegrationInput(raw: unknown): IntegrationInput` that throws one error listing every missing/invalid field (`commitRef`, `acceptance`, `regression.result|command|artifactRef`), used by `IntegrationService.complete`.

- [ ] **Step 1: Write failing test** `reports all missing integration fields in one error`: input `{ commitRef: sha }` → message contains `acceptance`, `regression.result`, `regression.command`, `regression.artifactRef`.
- [ ] **Step 2: Run** `npx vitest run src/app/integration.test.ts` → FAIL.
- [ ] **Step 3: Implement** with the existing `zod` contracts style (`src/domain/contracts.ts`); keep the gate-then-review ordering message: when evidence is accepted but review is missing, the error names the next command (`apos review ...`). Add a minimal `integration.json` example plus the order *evidence → independent review → `integration complete` again* to the README, the Lead skill and the Multi-WP brief.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix: integration complete validates all fields at once; document integration.json`

### Task 6: Activity shows error-only Codex sessions (#6)

**Files:**
- Modify: `src/ui/activity.ts` (`parseCodex`, `findTranscripts`)
- Test: `src/ui/activity.test.ts`

**Interfaces:**
- Produces: `parseCodex` emits `Activity` `{ kind: 'error', text: <payload.error.message> }` for an `event_msg` row whose `payload.type === 'task_complete'` and `payload.error` is set.

- [ ] **Step 1: Write failing test** `a Codex session that ends in usage_limit_exceeded is found and shows the error`: fixture rollout with `session_meta` cwd = worktree and one `task_complete` error row → `findTranscripts(...)` length 1, items contain the message.
- [ ] **Step 2: Run** `npx vitest run src/ui/activity.test.ts` → FAIL (`found: false`).
- [ ] **Step 3: Implement** the `event_msg` branch in `parseCodex`; check whether `findTranscripts` drops transcripts with zero items and keep a transcript when its `session_meta` matches even if items are empty.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix: web UI Activity shows Codex sessions that end in an error at start`

### Task 7: Goal create hash feedback (#7)

**Files:**
- Modify: `src/cli-app.ts` (`goalWithSource`), `README.md` ("The Goal contract")
- Test: `src/cli.test.ts`

- [ ] **Step 1: Write failing test** `goal create sha256 mismatch names the expected digest and the CRLF normalisation`: error contains the computed digest and "line endings".
- [ ] **Step 2: Run** `npx vitest run src/cli.test.ts` → FAIL.
- [ ] **Step 3: Implement** the message `Goal source sha256 does not match --source file: expected <digest> (CRLF is normalised to LF before hashing); omit "source" from goal.json to have APOS fill it.` and describe the omit-`source` shortcut in the README.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix: explain the goal source sha256 mismatch and the auto-filled source`

### Task 8: CLI empty states and `goal select` profile (#9, #4)

**Files:**
- Modify: `src/cli-app.ts` (`goal list`, `inbox`, `goal select`)
- Test: `src/cli.test.ts`

- [ ] **Step 1: Write failing tests**: `goal list prints a hint when there are no goals`; `inbox prints "Inbox is clean" when nothing waits`; `goal select prints the Lead agent and model` (`lead: <agent> model=<model> (<source>)` via `describeProfiles`).
- [ ] **Step 2: Run** `npx vitest run src/cli.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three outputs (stdout, exit 0); in `profile set`, warn when `--model` looks like another agent's family only if cheap (skip otherwise — YAGNI; note the typo case is already caught at dispatch by `launchReceipt` mismatch).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix: friendly empty states and show the Lead profile at goal select`

### Task 9: `skills:check` without a dev dir (#10)

**Files:**
- Modify: `scripts/promote-skills.mjs`
- Test: `scripts/promote-skills.test.ts`

- [ ] **Step 1: Write failing test** `--check without a dev dir validates the bundled skills and exits 0`.
- [ ] **Step 2: Run** `npx vitest run scripts/promote-skills.test.ts` → FAIL (exit 2).
- [ ] **Step 3: Implement** — when `check && !dev`: verify each `NAMES` skill exists under the stable dir and declares `apos-contract: <n>`; print `bundled skills OK (set APOS_DEV_SKILLS to compare with a development copy)`; exit 1 only if a bundled skill is missing or lacks the header. Promotion (non-check) without a dev dir keeps the usage error.
- [ ] **Step 4: Run** → PASS; run `npm run skills:check`.
- [ ] **Step 5: Commit** `fix: skills:check validates the bundled skills when no dev copy is given`

### Task 10: Verify #8 is already fixed and close the loop

**Files:**
- Test: `src/app/inbox.test.ts` (create if absent; `inbox.ts` has no test file today)

- [ ] **Step 1: Write test** `closed and stopped Goals show no awaiting-outcome notice` using the in-memory journal; this reproduces #8 as reported.
- [ ] **Step 2: Run** `npx vitest run src/app/inbox.test.ts`. Expected: PASS (commit `f191dd9` already filters `closed|stopped` in `buildInbox`). If it FAILS, fix `buildInbox` and note it in the commit.
- [ ] **Step 3: Commit** `test: pin that closed and stopped Goals leave the inbox`
- [ ] **Step 4:** Comment on the GitHub issues each task fixed (`Fixes #n` in the commit body) and close #8 with a reference to `f191dd9`.

## Self-Review

- **Coverage:** #2→T4, #3→T1+T2, #4/#9→T8, #5→T1, #6→T6, #7→T7, #8→T10, #10→T9, #11→T5, #12/#13→T3.
- **Open risks (verify while implementing, not decided here):** T3 assumes `session_caller_not_live` surfaces as `OrcaRefused.code`; T6 assumes `findTranscripts` filters empty-item transcripts; whether `GoalEventType` needs `lead-answered`. Step 1 of each task checks these before coding.
- **Order:** T1 before T2 (T2 reads T1's notice). T3 independent. T4–T9 independent of each other; do T4 early since it unblocks every agent run.
