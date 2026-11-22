# Bringing a project into APOS: the setup

The setup (`.apos/project.yaml`, `schemaVersion: 2`) is the only thing that decides what the gate runs for a project. It is protected: a delivery that edits it fails the gate (`APOS-PROTECTED`). A repo from before v2 (`schemaVersion: 1`) still works and counts as "no setup": every guarantee that depends on a setup is off and the Goal's own checks run as before.

## The steps

```
apos setup draft     # Lead: write a draft from the catalog (not committed)
  edit, then commit .apos/project.yaml
apos setup probe     # APOS: run every tool at that commit in clean worktrees
apos setup approve --commit <sha>      # Human
apos setup show      # the latest approved version
```

1. **Draft.** `apos setup draft [--part <name>=<dir>[:<stack>]]... [--force]` detects the stack of the repo root and of each directory one level down, then takes the first tool of each layer plus the stack's strict floor (forbidden patterns, sensitive files, `mutation.minScore: 70` when a Goal asks for mutation). It prints notes for anything it could not name: a part whose stack is not recognised stays empty with the note `chưa nhận ra stack`; it never guesses. It refuses to overwrite a v2 setup that already has parts without `--force`.
2. **Edit and commit.** Add or remove tools, set `floor`, `triggers`, `system` layers. The setup is judged from the commit, not the working tree.
3. **Probe.** `apos setup probe [--commit <rev>]` runs every tool in a clean worktree and records `setup-probed` in the project log. A tool passes when: the command runs (not "command not found", no timeout); its report reads, and a `junit` report holds at least one test; `runOne` run on the first test that ran produces exactly one test that did not skip, with the same id; L1 and L2 give the same ids and statuses on two runs. A setup with no tool does not pass.
4. **Approve.** `apos setup approve --commit <sha>` is a Human decision: type the commit back in a terminal, or pass `--on-behalf "<why>"`. It needs a passing probe of exactly that text, so a setup edited after its probe (different sha256) is refused. Each approval is a new version, 1, 2, 3 ...

## Format of the file

```
schemaVersion: 2
parts:        # one per technology; roots must differ
  backend: { root: backend, stack: java-gradle, layers: { L1: [ ...tools ] }, needsHuman: [...], forbid: [...] }
system: { L4: [ ...tools ] }                         # layers that span parts
floor: { submit: [L0, L1, L2], integrate: [L1, L2, L3], close: [L0, ..., L5] }
triggers: [{ when: { changed: ["frontend/src/ui/**"] }, at: submit, run: ["system.L4"] }]
mutation: { minScore: 70 }
```

A tool is a [catalog tool](catalog.md#a-tool) plus `when` (`always`, or `flag:<name>` for a Goal flag). A trigger's `run` entries are `<part>.<layer>` or `system.<layer>` and must name a layer the setup defines. "system" is not a part name. Layers run by stage (the gate runs them by layer from wave 4); today the setup is recorded, probed, approved and pinned.

## Loosening the strict floor

The draft starts strict. To loosen it for a project, edit `forbid` (patterns) or `floor` (layers per stage) in the setup, commit, probe, approve a new version. Dropping a floor layer for one package is a per-Goal exception and needs the Human.

## Changing the setup between Goals

Every change is a new version: edit, commit, probe, approve. A Goal pins the latest approved version at `goal approve` (`--setup-version <n>` pins an older approved one). A setup approved later does not change a Goal that is running. To move a Goal to the new version: `goal revise`, then `goal approve` again. `goal list` and the UI show `setup vN` or `không có setup`.

The first setup of a project is approved by the Human. Later changes (adding a tool or a layer) may be approved by an agent only on the Human's explicit say-so, with `--on-behalf "<where they agreed>"`.

## Switching to YAML

APOS reads and writes setup and catalog files through one object: `SetupCodec { extension, parse(text), stringify(value) }` (`src/domain/setup-codec.ts`). The shipped codec is JSON; a JSON file is valid YAML, which is why the setup keeps the name `.apos/project.yaml`. Moving to YAML means adding a YAML library, writing a second codec, injecting it in place of `jsonCodec` (`CliOptions.codec`, default in the setup commands) and converting `catalog/*.json`. Nothing else in the core changes.
