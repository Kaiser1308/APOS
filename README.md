# APOS v2 local CLI

APOS runs AI agents on software Goals. The design follows what the Hard12 runs showed works:

- one owner keeps the context of a whole block;
- correctness comes from a source-backed contract and a gate the controller runs itself, not from the owner's report;
- the Human decides WHAT and outcomes, not HOW.

Design: `debates/2026-11-08-apos/FINAL-DESIGN.md` (v2.1). Safety cases: `docs/fault-injection.md`.

## Roles and Human gates

| Who | Decides | Command |
| --- | --- | --- |
| PM + Human | WHAT: which Goals next, outcome, acceptance, appetite | `goal create --source`, **gate A** `goal approve --size --max-spend --max-minutes --max-attempts` |
| Human | which approved Goal runs next | **gate B** `lead recommend`, `goal select` |
| Lead | HOW: Solo or Multi-WP, packages, interfaces. No Human approval | `lead propose`, `lead commit` |
| Controller (no LLM) | machine checks, dispatch, gate, findings, retries, wake-ups, budget breakers | `controller tick` / `controller watch` |
| Reviewer | independent review in its own session, when required | dispatched by the controller |
| Human | outcome, and whether to merge | **gate D** `outcome close [--merge-to <branch>]`, `revise`, `stop` |

When the Lead chooses Multi-WP, the controller only **notifies** the Human (`apos inbox`).

Human-only commands refuse to run from any terminal or worktree APOS dispatched an agent into. Owners have a shell and know this CLI. The Human-only commands are:
- `goal approve`, `goal appetite` and `goal select`;
- `outcome close`, `outcome revise` and `outcome stop`;
- `gate confirm`, `blocker resolve` and `execution abandon-intent`.

`goal appetite` is the Human's overrun decision. It changes only the controller-held budget, never WHAT.

## Setup

Requires Node.js 24+, Git, and the Orca CLI with Codex enabled (default runtime).

In `~/.codex/config.toml`, set `check_for_update_on_startup = false` (an update prompt blocks Orca workers) and `multi_agent = false` under `[features]` (owners must not spawn sub-agents). The live smokes ran with both.

```powershell
cd apos
npm ci
npm run build
node dist/cli.js --repo C:\path\to\project init
```

`init` commits `.apos/project.yaml`, the APOS-owned skills under `.apos/skills/` (the core discipline `_core/execute.md` plus `pm`, `lead`, `worker` and `reviewer`), and entrypoint copies under `.claude/skills/`.

Controller state lives **outside the repo**, in `~/.apos/projects/<repo>-<hash>/` (override with `APOS_HOME`):

- `events/<GOAL>.jsonl`: an append-only, fsync'd, hash-chained event log; the source of truth;
- `state.sqlite`: an index, rebuildable from the log;
- `sources/<GOAL>/v<n>.md`: verbatim source snapshots;
- `artifacts/`: gate logs;
- `runtime.json`: optional role profiles.

The repo gets readable Goal documents committed only at milestones: Goal approved, plan accepted, verified, merged, outcome. Events committed into the repo by anyone else are ignored. `apos migrate` imports APOS v1 histories that still fit the contract.

## Goal contract

A Goal JSON (see `src/domain/contracts.ts`) has:

- `requirements[]`: every requirement lifted from the source, with its span, and `disposition: acceptance | excluded` (an excluded one needs a reason);
- `acceptance[]`: `requirementIds`, `examples`, `boundaries`, `prohibited`, `checkIds`, and optional `ambiguity` (`resolved` or `blocked`);
- `checks[]`: `{ kind: 'command', command, expect: 'pass' | 'no-new-failures', failurePattern?, runs, timeoutMs, env }` or `{ kind: 'manual', procedure, expectedResult }`.

`goal create --file goal.json --source brief.md` snapshots the source with its sha256. Approval refuses:

- an unmapped requirement;
- a `blocked` ambiguity;
- a missing appetite;
- a source snapshot that no longer matches.

The appetite is kept only by the controller. It never appears in documents or briefs.

## Solo flow

```text
apos goal create --file goal.json --source brief.md
apos goal approve GOAL-001 --size M --max-spend 20 --max-minutes 240 --max-attempts 3
apos lead recommend
apos goal select GOAL-001
apos lead propose --file execution.json
apos lead commit GOAL-001          # controller checks the plan and dispatches
apos controller watch              # or: apos controller tick
apos inbox                         # needs-decision, notices, verified Goals awaiting outcome
apos outcome close GOAL-001 --merge-to main
```

If a dispatch or resume outcome stays unknown for 10 minutes, it appears in `apos inbox`. Check `orca orchestration task-list`; if Orca created nothing, run `apos execution abandon-intent <id> --key <key> --reason ...`.

**What the controller checks before dispatch** (`lead commit`):

- the plan's source hash and Goal version;
- that there are no open questions;
- that the estimate fits the appetite;
- for Multi-WP: at least two packages, an acyclic graph, versioned interfaces (`name@vN`), acceptance coverage, and a split rationale.

**Dispatch.** The owner runs in its own Orca worktree, created from an exact base commit. It uses the role profile: Codex `gpt-6.1-terra` for Lead and Worker, `gpt-6-sol` for Reviewer. Override them in `runtime.json`. The brief points at `.apos/skills/_core/execute.md` and the role skill by path and sha256, and names the activation line the delivery report must contain.

**After the owner settles**, `controller tick` runs these steps:

1. Compare the launch receipt with the requested model. A mismatch is `needs-decision`.
2. Read the delivery head of the owner's worktree, and check that the committed report carries the activation line. If it does not, a finding resumes the same owner.
3. Run the gate: a fresh detached worktree at that exact commit, with a tree-killing timeout, comparing base and delivery failures. Logs are hashed in the controller home.
4. **Green.** If a review is required, a reviewer runs in a separate session. Review is required for Multi-WP, declared risks, changed tests or oracles, or shared paths changed. Otherwise the Goal is verified and waits for the Human.
5. **Red.** The controller records a finding (check IDs, commit, logs) and resumes the same owner in the same terminal and worktree.
6. **Stop** at `needs-decision` when:
   - the cause is unknown or the gate is unverifiable;
   - the same failure survives two repairs;
   - the attempt budget or wall time is spent;
   - the owner reports `failed`.

`outcome close --merge-to <branch>` records a one-time authorization for the gated commit and merges it. It then reruns the gate on the merge commit. If that gate is red, the Goal stays open.

**Manual checks** stay pending until someone other than the owner confirms them: `gate confirm GOAL-001 <checkId> --commit <sha> --by <name> --note "..."`.

**Findings** (`finding record --kind`):

- `intent_gap` parks the Goal for PM and the Human;
- `bad_plan` is for the Lead to revise;
- `patch` goes to the owner;
- `defer` goes to the backlog.

## Multi-WP flow

The Lead adds packages (`package add`). Each package names its owner, dependencies, versioned interfaces and local acceptance, optionally with `checkIds` from the Goal's checks. Then the Lead runs `lead commit GOAL-001 --terminal $ORCA_TERMINAL_HANDLE`.

The controller then:

- dispatches packages as their dependencies are verified;
- gates each settled package on its own head against its base. Green verifies the package. Red sends it back to the same owner with the finding;
- wakes the Lead's terminal once per batch of new events: package results, Worker questions, ready to integrate, a red integration gate. It only does so after the Lead's previous turn has settled.

`integration complete` gates the integration commit itself. Every Multi-WP Goal needs an independent Goal review before it can verify.

## Telemetry

`telemetry-recorded` events hold, per dispatch and role: requested and launched model, token usage (input, cached, output) read from the owner's Codex session files, and wall time. When nothing matches, the usage is recorded as `unknown`, never estimated. `metrics show` summarizes a Goal.

## Validation

- `npm test`: 150 tests, covering every safety case in `docs/fault-injection.md`; `npm run typecheck` and `npm run build` pass.
- **Live smoke (2026-11-08).** Real Orca 1.4.240 and codex-cli 0.167.0 with `gpt-6.1-terra` on throwaway repos:
  - **`GOAL-SMOKE-V2`.** Gate A, gate B and `lead commit` ran. The owner worked in its own Orca worktree from the exact base commit, and the launch receipt showed codex/gpt-6.1-terra. Its report carried the activation line, a full self-review and independent checks. The gate went green on the owner's worktree head, and the Goal verified. `outcome close --merge-to` on a disposable branch gave a green post-merge gate, and the terminal was released.
  - **`GOAL-SMOKE-R`, the repair path.** A break was injected after the first delivery. The gate went red, and the controller recorded the finding and resumed the same Codex terminal. The owner fixed the break, the gate went green on the new head, and the Goal verified and merged. Per-dispatch tokens: attempt 1 used 307k input (298k cached) and 2.5k output; the repair used 270k input (263k cached) and 2.0k output.
- **Problems the live runs found, all fixed and tested:**
  - multi-line briefs stalled in the Codex composer, and were refused on terminal reuse;
  - an owner committed into the managed checkout;
  - Orca timed out on a dispatch that had started, and APOS recovered it by key;
  - Orca refused a resume right after `worker_done` with `agent_unconfigured`;
  - telemetry double counting, and Windows not updating mtime.

## Open items

- **Spend is not enforced.** `maxSpendUsd` and `overrunPolicy` are recorded, but there is no price table, and an overrun only notifies. The controller cannot stop a running owner; it only declines to resume it.
- **Multi-WP has not run live.** It is covered by automated tests only, and the design orders it after Solo passes its trial.
- **The quality pilot has not run.** FINAL-DESIGN step 6, a paired comparison against `pm-onlyone`, still needs to be done. A smoke run proves the plumbing, not quality.
- **Solo loses the Lead's planning context.** The Solo owner is a fresh session dispatched after `lead commit`, not the session that wrote the plan.
- **Trust boundary.** The controller home is tamper-evident, not a security boundary against a process that runs as the same OS user.
