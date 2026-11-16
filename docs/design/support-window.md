# Design: a support window and an upgrade chain

Status: a proposal for the person. Nothing here is built.

Pullboard supports the current release and one back. Any older board walks forward to the current release with one command, one verified step at a time.

## The support window

- Supported: the current release and the release before it.
- A board inside the window opens and works with no step.
- A board outside the window is refused, and the refusal names one command: `pullboard upgrade`.

## The upgrade chain

- Each release ships exactly one migration, from the release before it.
- `pullboard upgrade` applies the migrations in order to any older board.
- After each step it stops at a verified, fingerprinted checkpoint: the board opens, `doctor` is clean and the row counts match.
- A stopped or failed upgrade resumes from the last checkpoint. It never starts over and never skips a step.

## How migrations are tested

- Every pair: each release's migration runs on a fixture board from the release before it.
- Run twice safely: the second run changes nothing.
- No lost rows: counts before and after must match, or the step refuses to finish.
- The whole chain runs on the oldest fixture board in the repo, on every release.

## Running agents and open claims

An upgrade runs when the board is quiet, between two moves. Open claims keep their holder, lease and frozen bar. A claim whose lease would lapse during the upgrade is extended by the upgrade's length, and the extension is recorded. Agents re-read the board after the upgrade, since their first command after it runs on the new release.

## Hosted boards

Hosted boards use the same chain, as set out in the hosted-upgrades design (#1499): the same migrations, the same checkpoints, run by us on a copy first. Nothing about hosting changes what a migration is.

## The smallest first version

`pullboard upgrade` with the one-step case: the release before to the current one, a checkpoint, a refusal outside the window that names the command, and the twice-safe test for that one pair. Multi-step chains and resume follow.

## Items building it would need

- Item: the migration contract, one migration per release, with its test harness.
- Item: `pullboard upgrade`, the chain runner with a checkpoint after each step.
- Item: the refusal for a board outside the window, naming the command.
- Item: the fixture boards for every supported release.
- Item: lease extension for open claims across an upgrade.

## Open decisions for the person

- Is the window two releases, or three while we are before v1?
- Does `upgrade` run on its own when a board is opened, or only when asked?
- How long do we keep the fixture boards of releases that left the window?
- A doctrine row is drafted for the person's OK: does a release without its migration count as unshippable?
