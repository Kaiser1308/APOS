# Orca adapter contract

Verified against Orca 1.4.240 on 2026-11-07. `orchestration run-create --objective ... --json` returns `result.run.id`. `orchestration worker-start --spec ... --worktree path:<repo> --agent claude --run <run> --json` returns `result.runId`, `taskId`, `dispatchId`, and an agent terminal in `result.effects`. `orchestration worker-show --dispatch <id> --json` returns `result.dispatch.status`, `projection.liveness.verdict`, and terminal observations. `orchestration run-list`, `task-list --run`, and `dispatch-show --task` are used to find a previously accepted attempt after a lost CLI response.

The smoke dispatch `ctx_cfc504ed2891` reached Claude Code in a disposable Git project. Claude Code reported a weekly usage limit and is scheduled to continue at 1am Asia/Ho_Chi_Minh. The dispatch remains live. Do not retry or release it without authoritative settlement.

Agent ids are Orca's: `codex`, `claude`, `antigravity`. Verified 2026-11-14 with Orca and Antigravity CLI 1.5.8: `worker-start --agent claude` opens a structured chat (handle `structworker_*`, `terminal read` returns a `[user]`/`[assistant]` transcript); `--agent antigravity` opens a TUI terminal. Screen rules per agent live in `screens.ts`, written from the captures in `fixtures/screens/`.

`orchestration worker-stop --dispatch <id> --json` returns `{ state: "stopped", processAction: "closed_agent_terminal" }`, and `worker-show` then reads the dispatch `failed`. APOS stops a dispatch only for a Human `apos handoff`, and treats the stop as sure only on `closed_agent_terminal` or a settled dispatch. The new agent starts with `worker-start --worktree id:<same worktree> --run <same Run>` and no `--terminal`.

An agent that runs out of quota makes Orca post an `escalation` on the Run (seen live 2026-11-14 with Codex, which Orca also opened as a chat): subject `Agent hit an error: Codex hit its usage limit.`, body `Details from the agent: You’ve hit your usage limit. …`, `payload.dispatchId`. Fixture: `fixtures/screens/codex/quota-escalation.json`.

The adapter must not call `worker-start` again when dispatch outcome is unknown. Its caller records `dispatch-intended` first and inspects Orca using the same key. A terminal being live is distinct from Task completion; `dispatch.status` governs settlement.
