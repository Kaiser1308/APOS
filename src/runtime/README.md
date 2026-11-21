# Orca adapter contract

Verified against Orca 1.4.265 on 2026-11-21, in a scratch Git repo, from a plain Orca terminal (the identity `apos controller watch` runs under). Raw `--json` captures of every record below are in `fixtures/orca-1.4.265/`, with local paths shortened. Orca 1.4.265 answers most verbs with a concise view; `--full` prints the stored record. `runOrca` (`orca/exec.ts`) adds `--full` only where APOS needs it.

- `orchestration run-create --objective ... --json` returns `result.runId` (older Orca: `result.run.id`; `runIdOf` reads both).
- `orchestration worker-start --spec ... --worktree new-top-level --repo path:<repo> --agent claude --run <run> --json` stays concise. It returns `runId`, `taskId`, `dispatchId`, `terminal` (the agent handle) and `workspace` (the worktree id), with no `effects`. The concise view exits 0 for `ready` and for a start whose turn Orca has not observed yet; `--full` exits 1 for anything but `ready`. If a `worker-start` still exits 1 with `stage` `turn_start_unobserved`, `runOrca` returns its receipt: the worker did start.
- `orchestration worker-show --dispatch <id>` is read `--full`: `dispatch.status`, `projection.liveness.verdict`, `worker.stage`, `worker.worktreeId`, `worker.startOptions.launch.effective`, `terminalResource.releaseState`. The concise view (APOS `--compact`) carries `activity` and `lastActivity`.
- `orchestration task-list --run <run>` is read `--full`. Its concise rows carry only `id`, `status`, `title`, `dispatchId` and `assignee`, and no `spec`, so recovery by `APOS dispatch key:` needs the full record.
- `orchestration dispatch-show --task <id>` (concise) returns `dispatch.id` and `dispatch.assignee_handle`.
- `orchestration run-list` (concise) returns `runs[].id`, `runs[].objective` and `nextCursor`.
- `orchestration run-list`, `task-list --run --full`, `dispatch-show --task` and `worker-show` find a previously accepted attempt after a lost CLI response. The G1 smoke started a real package worker, dropped the response, and `PackageService.reconcile` returned `recovered` with the same dispatch; the Run held exactly one Task and one worker.

## Runs and their coordinator

Only a Run's coordinator may start workers in it (`worker-start --run` answers `consumer_fenced` for anyone else: "This caller coordinates Run A, not B") or read its mail (`check --run` requires the current consumer). A terminal coordinates every Run it created with `run-create`, several at once. `run-use --id <run>` is the only way to take a Run over; it also unbinds every other Run of the caller and bumps each one's `consumer_generation` (Orca v1.4.265 source, `run-binding.ts` and `runs.ts`). So APOS never calls `run-use`: the controller, running in one plain Orca terminal, creates every Run and passes `--run <id>` on every call, and every other APOS command only records a request the controller carries out at its next tick (`src/app/controller-requests.ts`).

`orchestration run-show --id <run> --full` names the coordinator: `run.coordinator_handle` is the terminal's `ORCA_TERMINAL_HANDLE`, exactly (seen live: a `run-create` from a plain terminal stored that string; fixture `run-show-full.json`); a chat coordinator, or an unbound Run, reads `null`. The concise view has no coordinator. Each tick the controller compares it with its own terminal for every Run of an active Goal (`src/app/run-ownership.ts`), and leaves a Goal whose Run drifted to the Human. A package Run found by objective is reused only when this terminal coordinates it; otherwise the controller creates its own.

A plain Orca terminal has `ORCA_TERMINAL_HANDLE` and `ORCA_PANE_KEY` but no `ORCA_AGENT_SESSION_ID`; agent chats (bots, workers) have `ORCA_AGENT_SESSION_ID`. `worker-list` without `--run` is scoped to the caller's bound Run, so it cannot tell whether a process is a worker; APOS uses `ORCA_AGENT_SESSION_ID`, `orca bot chats` and the terminals and worktrees it dispatched instead.

## Mail

A consuming `orchestration check --run <run>` marks the batch it returns as handled and gives no Delivery id; `--ack` is only for older Orca. `check --peek` returns every unread message without marking it. APOS reads with `--peek` (`checkRun`) and consumes with a plain `check` (`ackRun`) only after it handled every message it read, so mail it leaves pending is unread on the next tick. Before consuming, `ackRun` peeks again: if unread mail the controller did not handle is there, it consumes nothing that tick, and all of it comes back. Only mail that lands between that peek and the consume is returned. The controller handles it in the same tick, and sends to the Human's inbox any of it that stays pending. Seen live: a peek, then a consume after more mail arrived, returned the same three messages, and the next peek was empty.

A chat coordinator (a `structworker_*` Orca session) gets its mail pushed into the chat, which marks it handled; only a terminal coordinator sees mail wait in `check`.

## Terminals and agents

Agent ids are Orca's: `codex`, `claude`, `antigravity`. `worker-start` runs the agent the way the user's "Chat | CLI" setting says; on this machine `--agent claude` opens a structured chat (handle `structworker_*`). Verified 2026-11-14 with Antigravity CLI 1.5.8: `--agent antigravity` opens a TUI terminal. Screen rules per agent live in `screens.ts`, written from the captures in `fixtures/screens/`.

`terminal read` returns accumulated output by default; the screen rules need the rendered screen, so the adapter reads `--screen`. The result names its `source`: `screen`, or `screen-unavailable` for a chat worker, where Orca returns the transcript instead (no error).

`orchestration worker-keep-open --dispatch <id>` (old name `worker-retain`) returns `{ state: "retained", reason, processAction }`. A worker started in a new worktree is kept open from the start (`terminalResource.releaseState: "retained"`).

`orchestration worker-stop --dispatch <id> --json` returns `{ state: "stopped", processAction: "closed_agent_terminal" }`, and `worker-show` then reads the dispatch `failed`. APOS stops a dispatch only for a Human `apos handoff`, and treats the stop as sure only on `closed_agent_terminal` or a settled dispatch. The new agent starts with `worker-start --worktree id:<same worktree> --run <same Run>` and no `--terminal`.

An agent that runs out of quota makes Orca post an `escalation` on the Run (seen live 2026-11-14 with Codex, which Orca also opened as a chat): subject `Agent hit an error: Codex hit its usage limit.`, body `Details from the agent: You’ve hit your usage limit. …`, `payload.dispatchId`. Fixture: `fixtures/screens/codex/quota-escalation.json`.

## Recovery

The adapter must not call `worker-start` again when dispatch outcome is unknown. Its caller records `dispatch-intended` first and inspects Orca using the same key. A recovery lookup that fails is not "nothing started": it throws, and the caller retries under the same key instead of starting a second agent. A terminal being live is distinct from Task completion; `dispatch.status` governs settlement.
