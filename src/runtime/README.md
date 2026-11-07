# Orca adapter contract

Verified against Orca 1.4.240 on 2026-11-07. `orchestration run-create --objective ... --json` returns `result.run.id`. `orchestration worker-start --spec ... --worktree path:<repo> --agent claude --run <run> --json` returns `result.runId`, `taskId`, `dispatchId`, and an agent terminal in `result.effects`. `orchestration worker-show --dispatch <id> --json` returns `result.dispatch.status`, `projection.liveness.verdict`, and terminal observations. `orchestration run-list`, `task-list --run`, and `dispatch-show --task` are used to find a previously accepted attempt after a lost CLI response.

The smoke dispatch `ctx_cfc504ed2891` reached Claude Code in a disposable Git project. Claude Code reported a weekly usage limit and is scheduled to continue at 1am Asia/Ho_Chi_Minh. The dispatch remains live. Do not retry or release it without authoritative settlement.

The adapter must not call `worker-start` again when dispatch outcome is unknown. Its caller records `dispatch-intended` first and inspects Orca using the same key. A terminal being live is distinct from Task completion; `dispatch.status` governs settlement.
