# APOS local CLI

APOS manages a project-local `.apos/` history and a local SQLite index. Orca runs Claude Code. The CLI supports Solo Goals and dependency-aware Work Packages. The dashboard remains under development.

## Setup

Requires Node.js 24+, Git, and an installed/running Orca CLI with Claude Code available.

```powershell
cd apos
npm ci
npm run build
node dist/cli.js --repo C:\path\to\project init
```

`init` creates `.apos/` and installs APOS PM, Lead, and Worker entrypoint skills under the project's `.claude/skills/`. Existing skill files are preserved. APOS writes `state.sqlite` locally and excludes it from Git; important events, decisions, specs, and evidence references are committed under `.apos/goals/`.

## Solo Goal flow

Create JSON files matching the Goal and Execution contracts in `src/domain/contracts.ts`. The Lead proposal must map every Goal acceptance ID to a verification method. Run these commands with `--repo` before the subcommand:

```text
apos goal create --file goal.json
apos goal approve GOAL-001
apos lead recommend
apos goal select GOAL-001
apos lead propose --file execution.json
apos execution approve GOAL-001
apos execution status GOAL-001
apos execution reconcile GOAL-001
apos evidence add GOAL-001 --file evidence.json
apos execution verify GOAL-001
apos outcome close GOAL-001
```

`execution approve` starts the approved Solo Goal through Orca automatically. If dispatch outcome is unknown, inspect the existing Run/Task/Dispatch and use `execution reconcile`; do not create another worker. A usage-limited Claude session remains a live dispatch until Orca proves settlement. Use `blocker report|resolve` and `decision record` for exceptions.

## Multi-Work-Package flow

After `lead propose --file execution.json` with `mode: "multi-wp"`, Lead drafts every package before Human approves the execution plan. Each package JSON names one owner, a cohesive outcome, scope, dependencies, interfaces, local acceptance criteria, and integration strategy. The approval gate checks at least two packages, the dependency graph, and coverage of Goal acceptance.

```text
apos package add --file wp-01.json
apos package add --file wp-02.json
apos package list GOAL-001
apos execution approve GOAL-001
apos package ready GOAL-001
apos package reconcile GOAL-001
apos package evidence GOAL-001 --file wp-01-evidence.json
apos package verify GOAL-001 WP-01
apos integration prepare GOAL-001
apos integration complete GOAL-001 --file integration-evidence.json
apos outcome close GOAL-001
```

`execution approve` dispatches the first dependency-ready wave automatically. Each Worker gets an Orca worktree. If an Orca response is unknown, `package reconcile` looks up the original Run, Task, and Dispatch; it does not start a duplicate Worker. `package verify` automatically dispatches newly ready dependents; `package dispatch` remains available after an interruption.

Package evidence includes `packageId`, `packageVersion`, `owner`, `acceptanceId`, `result`, `command`, `artifactRef`, and `commitRef`. Lead can use `package revise GOAL-001 --file revised.json --reason "..."`; affected downstream evidence becomes stale. Use `package block`, `package unblock`, and `package resume` to continue a parked Worker in its original terminal and worktree. Product blockers require a revised Goal approval.

`integration prepare` checks that all packages are verified, source commits exist, and files do not overlap unnoticed. `integration complete` requires an integration commit containing every package commit, passing Goal acceptance evidence, passing regression evidence, and a conflict resolution note when files overlap. It records technical verification; Human outcome closure remains separate. APOS merges only through `integration merge GOAL-001 --source <commit> --target <branch>`, and only when that Goal has `autoMergeAuthorized: true`, technical verification passed, the source matches delivery evidence, the target branch is checked out, and the worktree is clean.

`apos controller tick` is a mechanical recovery pass: it reconciles uncertain Orca dispatches, starts dependency-ready packages, and resumes stale package owners whose prior dispatch has settled. It reports unresolved attempts without claiming completion. Run it after a CLI interruption or from a local scheduler; it never polls with an LLM.

Evidence JSON has `acceptanceId`, `result` (`pass` or `fail`), `command`, and `artifactRef`. APOS requires the latest evidence for every acceptance criterion to pass before technical verification. Human outcome closure is a separate command. Automatic code merge is not performed by this Solo CLI slice, even if a Goal records merge authorization.
