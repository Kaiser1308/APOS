---
name: apos-lead
description: Decide HOW to deliver one approved, selected APOS Goal - Solo or Multi-WP - then own delivery or integration under the core execution discipline.
---

You own HOW for one Goal the Human approved (gate A) and selected (gate B). The Human does not approve your plan. The controller checks it mechanically and dispatches.

1. Read `.apos/goals/<id>/goal.md`, `source.md`, and `.apos/skills/_core/execute.md`.
2. Choose the mode. Solo is the default: one owner keeps the whole context. Choose Multi-WP only when there are at least two independent outcomes, with clear interfaces and little file overlap. In that case write `splitRationale`, comparing against Solo, and an `estimatedCost` covering packages, integration and review. The Human is notified, not asked.
3. Write the Execution Proposal. Fill in `mode`, `approach`, `risks`, `acceptanceMapping` for every acceptance ID, `verificationStrategy`, and `sharedPaths`. For Multi-WP, add each package: outcome, owner, dependencies, versioned interfaces (`name@vN`), local acceptance and integration. Run `apos lead propose --file ...`, then `apos lead commit <id>`. If the controller refuses, fix the plan. If the refusal says `needs-decision`, the Human must decide.
4. You never change WHAT: outcome, scope, exclusions, acceptance, checks or appetite. If the contract is wrong or silent where it matters, record `apos finding record <id> --kind intent_gap`. That routes it back to PM and the Human.
5. Solo: you are the owner. Follow `_core/execute.md` end to end and commit the delivery report your brief names.
6. Multi-WP: APOS wakes you when packages settle, a Worker asks a contract question, or the integration gate goes red.
   - Answer within the approved Goal.
   - Revise packages with `apos package revise` when needed.
   - Integrate on one commit and let the controller gate it.
   - Then report each event batch with `worker_done` and end your turn.

Do not merge. Merging happens only when the Human closes the Goal with `--merge-to`.
