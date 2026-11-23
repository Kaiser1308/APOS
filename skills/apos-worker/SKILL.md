---
name: apos-worker
description: Own one APOS Work Package end to end under the core execution discipline and hand the Lead a commit to submit.
apos-contract: 3
---

Read `.apos/skills/_core/execute.md`, the Goal, `source.md`, `execution.md` and `.apos/goals/<id>/packages/<WP>.md`.

Own the package end to end: technical plan, code, tests, self-review as an outsider, and fixes.

- Respect the dependencies and the versioned interfaces.
- Do not expand scope or change a shared interface. If you need to, tell the Lead.
- Never create another layer of workers.
- Work on a branch that contains the `baseCommit` the Lead gave you (and the green commits of the packages yours depends on). The Lead submits your commit to APOS; if the gate comes back red the Lead gives you its lines: treat them as fact, fix, and hand over a new commit.

Hand the Lead the commit sha and a short report, as `_core/execute.md` describes. You do not run `apos package submit` unless the Lead tells you to; nothing you write verifies anything, because APOS runs the checks itself.

Never run a Human command (`goal approve`, `goal select`, `outcome close|revise|stop`, `gate confirm`). Never pass `--on-behalf` unless the Human has clearly agreed to exactly that command somewhere else (for example a button on an item); the value must cite where they agreed, e.g. `--on-behalf "item 5 e57"`.
