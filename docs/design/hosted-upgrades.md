# Design: upgrading every hosted board with zero breakage

Status: a proposal for the person. Nothing here is built.

Every hosted board moves to each new Pullboard release without breaking and without the person doing anything. This page is about the release path; the support window and the upgrade chain it relies on are in the support-window design.

## Proving a release

Before any rollout, the release runs against copies of real hosted boards. Each copy is upgraded, then checked: the board opens, `doctor` is clean, every item keeps its status, and the next landing works. A release that fails on any copy does not roll out. The copies are taken with the owner's board kept private and are deleted after the run.

## Staged rollout and rollback

1. A canary set of boards, our own first, then a small share of hosted boards.
2. A hold period with checks running on each upgraded board: health, landing and gate.
3. A wider share, then all boards.
4. Any failed check stops the rollout and restores the board from the snapshot taken just before its upgrade. Rollback is automatic and needs no person.

## Board migrations

- Each release ships one migration from the release before it.
- A migration runs twice safely: the second run changes nothing.
- A migration never loses a row. It counts rows before and after, and refuses to finish on a mismatch.
- A migration writes a verified, fingerprinted checkpoint, so a stopped upgrade resumes from it.

## Running agents and open claims

An upgrade happens at a quiet moment for the board, between two moves. Open claims keep their holder, lease and frozen bar. Running agents finish the command they are in; the next command runs on the new release. A claim whose lease would lapse during the upgrade is extended by the length of the upgrade, and the extension is recorded.

## What the person sees

Nothing. If a release changes something they notice, one plain line appears in the chat: what changed, in a sentence. They never choose a version, and there is no upgrade button.

## Items building it would need

- Item: a job that copies hosted boards and runs a release against them.
- Item: staged rollout with per-stage checks and an automatic stop.
- Item: a snapshot before each upgrade and an automatic restore.
- Item: the migration harness that runs each migration twice and counts rows.
- Item: lease extension for claims across an upgrade.
- Item: the one-line change note in the chat.

## Open decisions for the person

- How long is the hold period at each stage?
- Do we keep private boards out of the proving copies, or copy them with the owner's consent?
- How many releases of snapshots do we keep for restore?
- May an urgent security fix skip the stages?
