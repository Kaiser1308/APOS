# APOS local CLI

APOS manages a project-local `.apos/` history and a local SQLite index. Orca runs Claude Code. This package currently implements the Solo Goal path; Multi-Work-Package execution and the dashboard are under development.

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

Evidence JSON has `acceptanceId`, `result` (`pass` or `fail`), `command`, and `artifactRef`. APOS requires the latest evidence for every acceptance criterion to pass before technical verification. Human outcome closure is a separate command. Automatic code merge is not performed by this Solo CLI slice, even if a Goal records merge authorization.
